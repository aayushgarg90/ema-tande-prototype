require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const app = express();
const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Step 1 — the booking chat. No intent classification: every message just
// continues one directed conversation whose only job is to collect the
// minimum trip details, then hand off to the Travel Agent (Step 2 below).
// ---------------------------------------------------------------------------

const CHAT_MODEL = 'claude-sonnet-5';

const CHAT_SYSTEM_PROMPT = [
  'You are a corporate travel booking assistant. Your ONLY goal in this conversation is to',
  'collect the minimum details needed to search for flights and a hotel, then confirm.',
  'Lead the conversation — do not wait for the employee to volunteer information. Ask for',
  'missing details yourself, ONE at a time, in this exact order: destination city, origin city,',
  'departure date, return date, number of travelers.',
  'Keep every reply to one or two short sentences and end with a single clear question for the',
  'next missing detail.',
  'When the employee answers, briefly acknowledge it, then ask for the next missing detail.',
  'If they give several details at once, capture them all and only ask for what is still missing.',
  "Normalize dates to a readable form like 'Thu Jul 16, 2026' when you can; if a date is",
  'ambiguous, ask. If the employee implies a solo trip, set travelers to "1".',
  'Trip purpose is optional — you may ask for it once but never block on it. Stay on task: if',
  'asked something off-topic, gently steer back to booking the trip.',
  'Always echo every value you already know in the trip object; never drop a previously-',
  'collected field.',
  'Set readyToBook to true ONLY once destination, origin, departure date, return date, and',
  'number of travelers are ALL known.',
  "When readyToBook is true, give a one-sentence summary of the trip and tell the employee",
  "you'll now find the best flights and a hotel."
].join(' ');

const CHAT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'trip', 'readyToBook'],
  properties: {
    reply: { type: 'string', description: 'The message to show the employee in the chat.' },
    trip: {
      type: 'object',
      additionalProperties: false,
      required: ['origin', 'destination', 'departDate', 'returnDate', 'purpose', 'travelers'],
      properties: {
        origin: { type: ['string', 'null'] },
        destination: { type: ['string', 'null'] },
        departDate: { type: ['string', 'null'] },
        returnDate: { type: ['string', 'null'] },
        purpose: { type: ['string', 'null'] },
        travelers: { type: ['string', 'null'] }
      }
    },
    readyToBook: { type: 'boolean' }
  }
};

// ---------------------------------------------------------------------------
// Step 2 — the Travel Agent. Fires once the chat has everything it needs.
// Real flight search via Kiwi.com's public MCP server (no auth required).
// Hotel search is NOT part of Kiwi's MCP tool surface, so it stays a clearly-
// labeled placeholder until we wire up a real hotel source.
// ---------------------------------------------------------------------------

const FLIGHT_MODEL = 'claude-sonnet-5';

// Kiwi.com's official remote MCP server — no auth required.
const KIWI_MCP_URL = 'https://mcp.kiwi.com';

const FLIGHT_SEARCH_SYSTEM_PROMPT = [
  'You are the Travel Agent for a corporate travel tool. You have a flight-search tool connected',
  'via MCP to Kiwi.com. Given the trip details, call the tool to search real flights, then select',
  'and return exactly the top 3 options, ranked by the best overall balance of price, duration,',
  'and stops ("best value").',
  'Only return real flights the tool actually returned. Never invent, estimate, or fill in a',
  'flight the tool did not return.',
  'Report prices in whatever currency the tool actually returned — do not convert or guess.'
].join(' ');

const FLIGHT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['flights', 'note'],
  properties: {
    flights: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'airline', 'depart_time', 'arrive_time', 'duration', 'duration_minutes', 'stops', 'price', 'currency'],
        properties: {
          id: { type: 'string', description: 'stable id for this specific flight offer' },
          airline: { type: 'string' },
          flight_number: { type: 'string' },
          depart_time: { type: 'string' },
          arrive_time: { type: 'string' },
          duration: { type: 'string', description: 'human-readable, e.g. "5h 40m"' },
          duration_minutes: { type: 'integer' },
          stops: { type: 'integer' },
          price: { type: 'number' },
          currency: { type: 'string' },
          booking_url: { type: 'string' }
        }
      }
    },
    note: { type: 'string', description: 'one short sentence on how these were ranked/selected' }
  }
};

// Deterministic placeholder hotel — NOT from Kiwi, NOT from Claude. Kept
// simple and clearly labeled until a real hotel search is wired up.
function placeholderHotel(destination) {
  const city = destination || 'your destination';
  return {
    name: city + ' City Center Hotel',
    area: 'Near city center',
    rate: 189,
    currency: 'USD',
    nights: 1,
    source: 'placeholder' // front end must show this is not a real search result
  };
}

// ---------------------------------------------------------------------------
// Step 3 — the Expense Agent.
//
// 3a. Report assembly: once a flight + hotel are booked, turn them into
// categorized, GL-coded expense line items — the same kind of classification
// job a real expense agent does against a live corporate-card feed, just
// applied to our own known booking instead of an external feed we don't have.
// The dollar amounts are always taken from the actual booking data, never
// from the model, so a formatting slip can never change what's billed.
//
// 3b. Receipt extraction: reads an actual uploaded receipt photo (Claude
// vision) and returns merchant/amount/category/GL — replacing the fixed
// demo receipt the "snap a receipt" flow used to always return.
// ---------------------------------------------------------------------------

const REPORT_MODEL = 'claude-sonnet-5';

const GL_CODES = {
  Airfare: '6010',
  Lodging: '6020',
  'Ground transport': '6030',
  Meals: '6040',
  Other: '6050'
};
const GL_MAP_TEXT = Object.entries(GL_CODES).map(function (e) { return e[0] + ' = ' + e[1]; }).join(', ');

const REPORT_SYSTEM_PROMPT = [
  'You are the Expense Agent for a corporate travel tool. You are given the flight and hotel a',
  'traveler just booked, and must turn them into two expense report line items: one for the',
  'flight (Airfare) and one for the hotel (Lodging).',
  'For each, write a short merchant name, a one-line subtitle with useful context (route/dates',
  'for the flight, nights/location for the hotel), and assign the category and GL code from this',
  'exact mapping: ' + GL_MAP_TEXT + '.',
  'Use the exact dollar amounts given to you — do not recalculate, round differently, or invent a',
  'number.'
].join(' ');

const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      // Claude's structured-output validator rejects minItems/maxItems values
      // other than 0 or 1 on array schemas — cardinality is enforced in code
      // instead (see the `.length !== 2` check below) and reinforced in the
      // system prompt ("exactly two items").
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['merchant', 'sub', 'category'],
        properties: {
          merchant: { type: 'string' },
          sub: { type: 'string' },
          category: { type: 'string', enum: Object.keys(GL_CODES) }
        }
      }
    }
  }
};

const RECEIPT_MODEL = 'claude-sonnet-5';

const RECEIPT_SYSTEM_PROMPT = [
  'You are the Expense Agent, reading a photo of a receipt submitted by a traveler for',
  'reimbursement. Extract the merchant name, the total amount charged, the currency, and the',
  'date on the receipt (if visible).',
  'Classify it into exactly one category and GL code from this mapping: ' + GL_MAP_TEXT + '.',
  'If the image is blurry, cut off, not a receipt, or you cannot make out an amount, set',
  'confident to false and explain why in note — do not guess a number.'
].join(' ');

const RECEIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['confident', 'merchant', 'amount', 'currency', 'date', 'category', 'note'],
  properties: {
    confident: { type: 'boolean' },
    merchant: { type: ['string', 'null'] },
    amount: { type: ['number', 'null'] },
    currency: { type: ['string', 'null'] },
    date: { type: ['string', 'null'] },
    category: { anyOf: [{ type: 'string', enum: Object.keys(GL_CODES) }, { type: 'null' }] },
    note: { type: 'string', description: 'short note; explains low confidence if any' }
  }
};

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

// The SDK already retries transient errors a couple of times internally
// (see `maxRetries` on the Anthropic client) before ever throwing — so if one
// of these reaches here, retries were already exhausted. Map it to a status
// code and message that actually tells the traveler what to do, instead of
// surfacing the raw Anthropic error JSON.
function claudeErrorResponse(err) {
  const type = err && err.error && err.error.error && err.error.error.type;
  if (err.status === 529 || type === 'overloaded_error') {
    return { status: 503, message: 'Claude is briefly overloaded right now — please try again in a few seconds.' };
  }
  if (err.status === 429 || type === 'rate_limit_error') {
    return { status: 429, message: 'Rate limited — please wait a moment and try again.' };
  }
  return { status: 500, message: (err && err.message) || 'request failed' };
}

app.use(express.json({ limit: '10mb' })); // receipt photos are base64-encoded in the body
app.use(express.static(__dirname));

app.post('/api/chat', async (req, res) => {
  const messages = Array.isArray(req.body && req.body.messages) ? req.body.messages : [];
  if (!messages.length) {
    return res.status(400).json({ error: 'messages array is required' });
  }
  if (messages.length > 40) {
    return res.status(413).json({ error: 'conversation too long' });
  }

  try {
    const response = await client.messages.create({
      model: CHAT_MODEL,
      max_tokens: 1024,
      system: CHAT_SYSTEM_PROMPT,
      output_config: { format: { type: 'json_schema', schema: CHAT_SCHEMA } },
      messages: messages
    });

    const textBlock = response.content.find(function (b) { return b.type === 'text'; });
    const parsed = textBlock ? JSON.parse(textBlock.text) : null;
    if (!parsed || !parsed.reply) {
      return res.status(502).json({ error: 'model did not return a valid reply' });
    }
    res.json(parsed);
  } catch (err) {
    console.error('chat error:', err);
    const mapped = claudeErrorResponse(err);
    res.status(mapped.status).json({ error: mapped.message });
  }
});

app.post('/api/search-flights', async (req, res) => {
  const body = req.body || {};
  if (!body.destination || !body.departDate) {
    return res.status(400).json({ error: 'destination and departDate are required' });
  }

  const userPrompt = [
    'Search flights for this trip:',
    'From: ' + (body.origin || 'unspecified'),
    'To: ' + body.destination,
    'Depart: ' + body.departDate,
    body.returnDate ? ('Return: ' + body.returnDate) : 'One-way',
    'Travelers: ' + (body.travelers || 1)
  ].join('\n');

  try {
    const response = await client.beta.messages.create({
      model: FLIGHT_MODEL,
      max_tokens: 2000,
      betas: ['mcp-client-2025-11-20'],
      system: FLIGHT_SEARCH_SYSTEM_PROMPT,
      mcp_servers: [{ type: 'url', name: 'kiwi', url: KIWI_MCP_URL }],
      tools: [{ type: 'mcp_toolset', mcp_server_name: 'kiwi' }],
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: FLIGHT_SCHEMA }
      },
      messages: [{ role: 'user', content: userPrompt }]
    });

    const textBlock = response.content.find(function (b) { return b.type === 'text'; });
    const parsed = textBlock ? JSON.parse(textBlock.text) : null;
    if (!parsed || !Array.isArray(parsed.flights)) {
      return res.status(502).json({ error: 'no flight results returned' });
    }

    res.json({
      flights: parsed.flights.slice(0, 3),
      note: parsed.note,
      hotel: placeholderHotel(body.destination)
    });
  } catch (err) {
    console.error('search-flights error:', err);
    const mapped = claudeErrorResponse(err);
    res.status(mapped.status).json({ error: mapped.message });
  }
});

app.post('/api/generate-report', async (req, res) => {
  const body = req.body || {};
  const flight = body.flight || {};
  const hotel = body.hotel || {};
  if (!flight.price || !hotel.rate) {
    return res.status(400).json({ error: 'a selected flight and hotel are required' });
  }

  const nights = hotel.nights || 1;
  const hotelTotal = Math.round(hotel.rate * nights * 100) / 100;

  const userPrompt = [
    'Flight booked:',
    'Airline: ' + (flight.airline || 'Unknown') + ' ' + (flight.flight_number || ''),
    'Route: ' + (body.trip && body.trip.origin || 'Unknown') + ' -> ' + (body.trip && body.trip.destination || 'Unknown'),
    'Date: ' + (body.trip && body.trip.departDate || 'Unknown'),
    'Price: ' + flight.price + ' ' + (flight.currency || 'USD'),
    '',
    'Hotel booked:',
    'Name: ' + (hotel.name || 'Unknown'),
    'Area: ' + (hotel.area || ''),
    'Nights: ' + nights,
    'Total: ' + hotelTotal + ' ' + (hotel.currency || 'USD')
  ].join('\n');

  try {
    const response = await client.messages.create({
      model: REPORT_MODEL,
      max_tokens: 600,
      system: REPORT_SYSTEM_PROMPT,
      output_config: { format: { type: 'json_schema', schema: REPORT_SCHEMA } },
      messages: [{ role: 'user', content: userPrompt }]
    });

    const textBlock = response.content.find(function (b) { return b.type === 'text'; });
    const parsed = textBlock ? JSON.parse(textBlock.text) : null;
    if (!parsed || !Array.isArray(parsed.items) || parsed.items.length !== 2) {
      return res.status(502).json({ error: 'could not assemble report line items' });
    }

    // Amounts always come from our own booking data, never from the model.
    const items = [
      Object.assign({}, parsed.items[0], { amt: flight.price, gl: GL_CODES[parsed.items[0].category] || GL_CODES.Airfare }),
      Object.assign({}, parsed.items[1], { amt: hotelTotal, gl: GL_CODES[parsed.items[1].category] || GL_CODES.Lodging })
    ];
    res.json({ items });
  } catch (err) {
    console.error('generate-report error:', err);
    const mapped = claudeErrorResponse(err);
    res.status(mapped.status).json({ error: mapped.message });
  }
});

// ---------------------------------------------------------------------------
// Step 3d — Approver Assist: the real policy-check behind the manager's
// "Approval Assist" screen. Given the report's actual line items (whatever
// they are this session — flight, hotel, a snapped receipt, an inbox
// receipt), Claude checks each against POLICY.md and decides what, if
// anything, is a genuine exception, plus a manager-facing summary and
// recommendation. Replaces the old hardcoded "$180 client dinner" narrative.
// ---------------------------------------------------------------------------

const EVALUATE_MODEL = 'claude-sonnet-5';

// Read fresh on every check (not cached at startup) so editing POLICY.md
// takes effect on the very next report — no server restart needed.
function buildEvaluateSystemPrompt() {
  const policyText = fs.readFileSync(path.join(__dirname, 'POLICY.md'), 'utf8');
  return [
    'You are the Expense Agent, checking a traveler\'s expense report line items against the',
    'company travel & expense policy below, before it reaches a manager for approval.',
    '',
    'POLICY:',
    policyText,
    '',
    'For each line item, decide whether it is a genuine policy exception. Only flag real',
    'violations — being the largest item on the report is not a reason to flag something. If an',
    'item is flagged, reason must cite the specific rule and number from the policy in one short',
    'sentence a manager could read and immediately understand (e.g. "Meals over $75/person require',
    'attendees or client-entertainment coding — this is $180 with none listed."). If not flagged,',
    'reason must be an empty string.',
    'Also write a 2-3 sentence manager-facing summary of the whole report (what it is, how many',
    'items, whether anything needs their attention and why), and set recommendation to "approve" if',
    'nothing is flagged or "review" if at least one item needs a manager\'s judgment call.'
  ].join(' ');
}

const EVALUATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items', 'summary', 'recommendation'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['n', 'flagged', 'reason'],
        properties: {
          n: { type: 'integer', description: 'echo back the line item number given to you' },
          flagged: { type: 'boolean' },
          reason: { type: 'string' }
        }
      }
    },
    summary: { type: 'string' },
    recommendation: { type: 'string', enum: ['approve', 'review'] }
  }
};

app.post('/api/evaluate-report', async (req, res) => {
  const body = req.body || {};
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) {
    return res.status(400).json({ error: 'items array is required' });
  }

  const userPrompt = [
    'Trip: ' + (body.destination || 'unspecified') + ' — ' + (body.dates || 'dates unspecified'),
    '',
    'Line items:',
    items.map(function (it) {
      return '#' + it.n + ': ' + (it.merchant || 'Unknown') + ' — ' + (it.sub || '') +
        ' — category: ' + (it.cat || 'Other') + ' — amount: $' + it.amt;
    }).join('\n')
  ].join('\n');

  try {
    const response = await client.messages.create({
      model: EVALUATE_MODEL,
      max_tokens: 1200,
      system: buildEvaluateSystemPrompt(),
      output_config: { format: { type: 'json_schema', schema: EVALUATE_SCHEMA } },
      messages: [{ role: 'user', content: userPrompt }]
    });

    const textBlock = response.content.find(function (b) { return b.type === 'text'; });
    const parsed = textBlock ? JSON.parse(textBlock.text) : null;
    if (!parsed || !Array.isArray(parsed.items)) {
      return res.status(502).json({ error: 'could not evaluate report against policy' });
    }
    res.json(parsed);
  } catch (err) {
    console.error('evaluate-report error:', err);
    const mapped = claudeErrorResponse(err);
    res.status(mapped.status).json({ error: mapped.message });
  }
});

app.post('/api/extract-receipt', async (req, res) => {
  const body = req.body || {};
  if (!body.image || !body.mediaType) {
    return res.status(400).json({ error: 'image and mediaType are required' });
  }
  if (ALLOWED_IMAGE_TYPES.indexOf(body.mediaType) === -1) {
    return res.status(400).json({ error: 'unsupported image type — use jpeg, png, gif, or webp' });
  }

  try {
    const response = await client.messages.create({
      model: RECEIPT_MODEL,
      max_tokens: 500,
      system: RECEIPT_SYSTEM_PROMPT,
      output_config: { format: { type: 'json_schema', schema: RECEIPT_SCHEMA } },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: body.mediaType, data: body.image } },
          { type: 'text', text: 'Extract this receipt.' }
        ]
      }]
    });

    const textBlock = response.content.find(function (b) { return b.type === 'text'; });
    const parsed = textBlock ? JSON.parse(textBlock.text) : null;
    if (!parsed) {
      return res.status(502).json({ error: 'could not read the receipt' });
    }
    res.json(Object.assign({}, parsed, { gl: parsed.category ? GL_CODES[parsed.category] : null }));
  } catch (err) {
    console.error('extract-receipt error:', err);
    const mapped = claudeErrorResponse(err);
    res.status(mapped.status).json({ error: mapped.message });
  }
});

// ---------------------------------------------------------------------------
// Step 3c — Expense Agent: scan a real Gmail inbox for trip receipts, and
// surface them as accept/dismiss suggestions rather than auto-adding them.
// Uses IMAP + an app password (not OAuth) — the simplest way to read a real
// mailbox for a prototype.
//
// Matching rule (deliberately simple for a demo, in place of a real
// itinerary-matching engine): an email counts as "for this trip" when its
// subject line is exactly the trip's destination city. Send a receipt to the
// inbox with the subject set to e.g. "Chicago" and it's a candidate. Claude's
// only job past that point is to read the one matched email and decide
// whether it's actually a receipt worth extracting — not to judge relevance.
// ---------------------------------------------------------------------------

const INBOX_MODEL = 'claude-sonnet-5';
const MAX_INBOX_MESSAGES = 30; // most recent N messages scanned for a subject match
const MAX_INBOX_ATTACHMENTS = 3; // per matched email, image/pdf attachments sent to Claude

// UIDs already judged (surfaced-and-added, surfaced-and-dismissed, or judged
// not a receipt) so re-checking the inbox doesn't re-ask about the same email.
// In-memory only — resets on server restart, which is fine for a prototype.
const INBOX_SEEN_UIDS = new Set();

const INBOX_SCAN_SYSTEM_PROMPT = [
  'You are the Expense Agent, reading one email whose subject line already matches the',
  'destination city of a traveler\'s trip — treat it as belonging to this trip.',
  'Set isReceipt to true only if the email itself documents a real purchase (a receipt, invoice,',
  'order confirmation, or payment confirmation) — not a marketing email, newsletter, or unrelated',
  'notification that merely happens to share the subject line.',
  'When isReceipt is true, extract the total amount charged, the currency, and the date on the',
  'receipt (if visible), and classify it into exactly one category and GL code from this mapping:',
  GL_MAP_TEXT + '.',
  'Also extract a merchant name if one is stated; if none is stated, do NOT leave merchant null —',
  'write a short generic label instead, e.g. "Parking" or "Meal" based on the category, so every',
  'receipt still gets a readable line-item name.',
  'confident reflects your certainty in the AMOUNT specifically, not whether every field (like',
  'merchant) is present — a terse email that clearly states one charge (e.g. "Parking $19") is',
  'still confident:true. Set confident to false only when you cannot make out a clear amount, and',
  'explain why in reason — do not guess a number in that case.',
  'reason must be one short sentence a traveler could read to understand your judgment.'
].join(' ');

const INBOX_SCAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['isReceipt', 'confident', 'merchant', 'amount', 'currency', 'date', 'category', 'reason'],
  properties: {
    isReceipt: { type: 'boolean' },
    confident: { type: 'boolean' },
    merchant: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    amount: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    currency: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    date: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    category: { anyOf: [{ type: 'string', enum: Object.keys(GL_CODES) }, { type: 'null' }] },
    reason: { type: 'string' }
  }
};

// Best-effort plain text from an HTML body (mailparser only gives .text when
// the sender included a real text/plain part — many receipt emails don't).
function htmlToPlainText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

async function judgeInboxMessage(parsed) {
  const bodyText = (parsed.text && parsed.text.trim()) || htmlToPlainText(parsed.html) || '(no body text)';
  const attachments = (parsed.attachments || [])
    .filter(function (a) { return ALLOWED_IMAGE_TYPES.indexOf(a.contentType) !== -1 || a.contentType === 'application/pdf'; })
    .slice(0, MAX_INBOX_ATTACHMENTS);

  const content = [{
    type: 'text',
    text: 'Email to judge:\nFrom: ' + (parsed.from && parsed.from.text || 'unknown')
      + '\nSubject: ' + (parsed.subject || '(no subject)')
      + '\nDate: ' + (parsed.date ? parsed.date.toISOString() : 'unknown')
      + '\nBody:\n' + bodyText.slice(0, 4000)
  }];
  attachments.forEach(function (a) {
    if (a.contentType === 'application/pdf') {
      content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.content.toString('base64') } });
    } else {
      content.push({ type: 'image', source: { type: 'base64', media_type: a.contentType, data: a.content.toString('base64') } });
    }
  });

  const response = await client.messages.create({
    model: INBOX_MODEL,
    max_tokens: 500,
    system: INBOX_SCAN_SYSTEM_PROMPT,
    output_config: { format: { type: 'json_schema', schema: INBOX_SCAN_SCHEMA } },
    messages: [{ role: 'user', content: content }]
  });
  const textBlock = response.content.find(function (b) { return b.type === 'text'; });
  return textBlock ? JSON.parse(textBlock.text) : null;
}

app.post('/api/check-inbox', async (req, res) => {
  const body = req.body || {};
  if (!process.env.GMAIL_ADDRESS || !process.env.GMAIL_APP_PASSWORD) {
    return res.status(501).json({ error: 'Inbox not connected — set GMAIL_ADDRESS and GMAIL_APP_PASSWORD in .env to enable inbox scanning.' });
  }
  const destination = (body.destination || '').trim();
  if (!destination) {
    return res.status(400).json({ error: 'destination is required' });
  }

  // A fresh trip may reuse a subject line a previous trip already judged, so
  // the client asks for a clean slate on the first check of each new trip.
  if (body.resetSeen) INBOX_SEEN_UIDS.clear();

  const imapClient = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: process.env.GMAIL_ADDRESS, pass: process.env.GMAIL_APP_PASSWORD },
    logger: false
  });

  const suggestions = [];
  let scanned = 0;
  try {
    await imapClient.connect();
    const lock = await imapClient.getMailboxLock('INBOX');
    try {
      const status = await imapClient.status('INBOX', { messages: true });
      const total = status.messages || 0;
      if (total > 0) {
        const from = Math.max(1, total - MAX_INBOX_MESSAGES + 1);
        const range = from + ':' + total;

        // Cheap first pass: match by subject line only (no body fetch yet).
        const matchedUids = [];
        for await (const msg of imapClient.fetch(range, { uid: true, envelope: true })) {
          if (INBOX_SEEN_UIDS.has(msg.uid)) continue;
          const subject = ((msg.envelope && msg.envelope.subject) || '').trim();
          if (subject.toLowerCase() === destination.toLowerCase()) matchedUids.push(msg.uid);
        }
        scanned = matchedUids.length;

        // Second pass: only matched emails get their body/attachments pulled
        // and sent to Claude.
        const judgments = await Promise.all(matchedUids.map(function (uid) {
          return imapClient.fetchOne(uid, { source: true })
            .then(function (full) { return simpleParser(full.source); })
            .then(function (parsed) { return judgeInboxMessage(parsed).then(function (j) { return { uid: uid, parsed: parsed, j: j }; }); })
            .catch(function (err) { console.warn('inbox message skipped:', err.message); return null; });
        }));
        judgments.forEach(function (r) {
          if (!r) return;
          INBOX_SEEN_UIDS.add(r.uid);
          const j = r.j;
          // Cardinality that actually matters for a financial line item: a real
          // receipt with a clear amount. A missing merchant name is cosmetic —
          // fall back to a label rather than silently dropping a valid receipt
          // (this is exactly how a terse email like "Parking $19" was lost).
          if (j && j.isReceipt && j.confident && j.amount != null) {
            suggestions.push({
              uid: r.uid,
              subject: r.parsed.subject || '(no subject)',
              from: (r.parsed.from && r.parsed.from.text) || 'unknown sender',
              merchant: j.merchant || (j.category || 'Receipt'),
              amount: j.amount,
              currency: j.currency || 'USD',
              date: j.date,
              category: j.category || 'Other',
              gl: j.category ? GL_CODES[j.category] : GL_CODES.Other,
              reason: j.reason
            });
          }
        });
      }
    } finally {
      lock.release();
    }
    await imapClient.logout();
  } catch (err) {
    try { imapClient.close(); } catch (e) {}
    console.error('check-inbox error:', err);
    if (err.authenticationFailed) {
      return res.status(500).json({
        error: 'Gmail rejected those credentials. GMAIL_APP_PASSWORD must be a 16-character App Password ' +
          '(https://myaccount.google.com/apppasswords) generated for GMAIL_ADDRESS — not the account\'s ' +
          'regular login password — and the account needs 2-Step Verification turned on first.'
      });
    }
    const mapped = claudeErrorResponse(err);
    return res.status(mapped.status).json({ error: mapped.message });
  }

  res.json({ suggestions: suggestions, scanned: scanned });
});

app.listen(PORT, function () {
  console.log('Ema server running at http://localhost:' + PORT);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('Warning: ANTHROPIC_API_KEY is not set — /api/chat and /api/search-flights will fail until it is.');
  }
});

// Optional AI layer: Claude via the official Anthropic SDK, called straight from the browser with
// the user's own API key (bring-your-own-key). The key is only ever sent to api.anthropic.com.
//   1. Design brief → structured problem setup (JSON-schema structured output)
//   2. Design review → vision + engineering metrics → streamed Markdown review

import { MATERIALS, MATERIAL_IDS } from '../fea/materials.js';
import { normalizeProblem } from '../fea/topopt.js';

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.128.0/+esm';
export const MODEL = 'claude-opus-5-5';
const KEY_NAME = 'loadpath.anthropicKey';

let sdk = null;
let client = null;

const store = (kind) => { try { return window[kind]; } catch { return null; } };

export function getKey() {
  try { return store('sessionStorage')?.getItem(KEY_NAME) || store('localStorage')?.getItem(KEY_NAME) || ''; } catch { return ''; }
}

export function setKey(key, remember = false) {
  client = null;
  for (const kind of ['sessionStorage', 'localStorage']) {
    try { store(kind)?.removeItem(KEY_NAME); } catch { /* storage blocked */ }
  }
  if (!key) return;
  try { store(remember ? 'localStorage' : 'sessionStorage')?.setItem(KEY_NAME, key.trim()); } catch { /* storage blocked */ }
}

export const hasKey = () => Boolean(getKey());

export class ClaudeError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

async function getClient() {
  if (!hasKey()) throw new ClaudeError('Add your Anthropic API key in Settings to use Claude.', 'no_key');
  if (!sdk) sdk = await import(SDK_URL);
  if (!client) client = new sdk.default({ apiKey: getKey(), dangerouslyAllowBrowser: true });
  return client;
}

function explain(err) {
  const A = sdk?.default;
  if (A && err instanceof A.AuthenticationError) return new ClaudeError('That API key was rejected. Check it in Settings.', 'auth');
  if (A && err instanceof A.PermissionDeniedError) return new ClaudeError('This key does not have access to the model.', 'permission');
  if (A && err instanceof A.RateLimitError) return new ClaudeError('Rate limited. Wait a moment and try again.', 'rate_limit');
  if (A && err instanceof A.APIUserAbortError) return new ClaudeError('Stopped.', 'aborted');
  if (A && err instanceof A.APIConnectionError) return new ClaudeError('Could not reach the Anthropic API. Check your connection.', 'network');
  if (A && err instanceof A.APIError) return new ClaudeError(`Anthropic API error (${err.status ?? 'unknown'}): ${err.message}`, 'api');
  return err instanceof ClaudeError ? err : new ClaudeError(String(err?.message || err), 'unknown');
}

// Retry server-side on Anthropic's recommended fallback model if a safety classifier declines.
const FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };

// ----- 1. Design brief → problem setup ----------------------------------------------------------

const rect = {
  type: 'object',
  additionalProperties: false,
  required: ['x0', 'y0', 'x1', 'y1'],
  properties: { x0: { type: 'number' }, y0: { type: 'number' }, x1: { type: 'number' }, y1: { type: 'number' } },
};

const SETUP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'width_mm', 'height_mm', 'thickness_mm', 'material', 'volume_fraction', 'supports', 'loads', 'keep_out', 'keep_in', 'assumptions'],
  properties: {
    name: { type: 'string', description: 'Short part name, e.g. "Bike rack bracket"' },
    width_mm: { type: 'number' },
    height_mm: { type: 'number' },
    thickness_mm: { type: 'number', description: 'Plate thickness (out-of-plane extrusion depth)' },
    material: { type: 'string', enum: MATERIAL_IDS },
    volume_fraction: { type: 'number', description: 'Fraction of the design domain to fill, 0.15–0.6' },
    supports: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [...rect.required, 'fix'],
        properties: { ...rect.properties, fix: { type: 'string', enum: ['xy', 'x', 'y'] } },
      },
    },
    loads: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['x', 'y', 'fx_N', 'fy_N'],
        properties: { x: { type: 'number' }, y: { type: 'number' }, fx_N: { type: 'number' }, fy_N: { type: 'number' } },
      },
    },
    keep_out: { type: 'array', items: rect },
    keep_in: { type: 'array', items: rect },
    assumptions: { type: 'array', items: { type: 'string' }, description: 'Every value you had to assume, in plain English' },
  },
};

const SETUP_SYSTEM = `You are a senior mechanical design engineer setting up a 2D topology-optimization study (plane stress, linear elastic, minimum compliance subject to a volume limit).

Translate the user's description into a problem definition:
- The design domain is a W × H rectangle (mm), extruded through thickness_mm. All loads act in the plane of the plate. If the user describes out-of-plane loading, model the in-plane cross-section that carries it and say so in assumptions.
- Coordinates are NORMALIZED to the domain: x and y in [0, 1], origin at the bottom-left, y pointing UP.
- supports: rectangles of nodes that are held fixed. An edge is a zero-thickness rectangle (e.g. the full left edge is x0=0, x1=0, y0=0, y1=1). A bolt or pin is a short segment of an edge (about 0.04–0.15 long). fix: "xy" = clamped/pinned, "y" = roller that only resists vertical motion, "x" = roller that only resists horizontal motion. The supports together MUST prevent sliding in x and y and rotation.
- loads: point forces in newtons at normalized positions, normally on the domain boundary or on a keep_in region. Negative fy_N points down. Represent a distributed load as 3–6 point loads that add up to the total. Convert masses to weight (1 kg ≈ 9.81 N) and apply any safety/dynamic factor the user mentions.
- keep_out: rectangles that must stay empty (clearance for a shaft, a bolt head, a cable run, an existing part).
- keep_in: rectangles that must stay solid (mounting flanges, a deck surface, bolt bosses).
- Material: choose from ${MATERIAL_IDS.map((id) => `${id} (${MATERIALS[id].name})`).join(', ')}. Pick the one that best fits the user's process (3D printing, CNC, sheet cutting) when they don't name one.
- volume_fraction: 0.25–0.45 is typical. Lower means lighter but less stiff.
Pick realistic engineering defaults for anything unspecified and list each one in assumptions. Keep the aspect ratio between 1:4 and 4:1.`;

/**
 * @returns {Promise<{problem: object, notes: string[], source: 'claude'}>}
 */
export async function briefToProblem(brief, { signal } = {}) {
  const c = await getClient();
  try {
    const msg = await c.beta.messages.create(
      {
        model: MODEL,
        max_tokens: 16000,
        system: SETUP_SYSTEM,
        messages: [{ role: 'user', content: `<design_brief>\n${brief}\n</design_brief>` }],
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: SETUP_SCHEMA } },
        ...FALLBACK,
      },
      { signal },
    );
    if (msg.stop_reason === 'refusal') throw new ClaudeError('Claude declined this brief. Try rephrasing it.', 'refusal');
    if (msg.stop_reason === 'max_tokens') throw new ClaudeError('The response was cut off. Try a shorter brief.', 'max_tokens');
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    let raw;
    try { raw = JSON.parse(text); } catch { throw new ClaudeError('Claude returned an unreadable setup. Please try again.', 'parse'); }
    const problem = normalizeProblem({
      name: raw.name,
      width: raw.width_mm,
      height: raw.height_mm,
      thickness: raw.thickness_mm,
      material: raw.material,
      volfrac: raw.volume_fraction,
      supports: raw.supports,
      loads: (raw.loads || []).map((l) => ({ x: l.x, y: l.y, fx: l.fx_N, fy: l.fy_N })),
      keepOut: raw.keep_out,
      keepIn: raw.keep_in,
    });
    return { problem, notes: (raw.assumptions || []).map(String), source: 'claude' };
  } catch (err) {
    throw explain(err);
  }
}

// ----- 2. Design review (vision + metrics, streamed) -----------------------------------------

const REVIEW_SYSTEM = `You are a principal mechanical engineer reviewing a topology-optimized part for a junior engineer. You receive a rendering of the optimized 2D design (dark = material; supports in teal, loads as orange arrows, keep-out zones hatched red) and the verified FEA results.

Write a concise, specific design review in Markdown with these sections:
### Load paths
How the structure carries the load to the supports (ties vs. struts, arches, triangulation) and why the optimizer chose this layout.
### Strength & stiffness
Interpret the safety factor and deflection against the stated material. Point out where stress concentrates and if the margin is adequate for a static part (say what margin you'd want for fatigue or impact).
### Manufacturability
Concrete DFM advice for the suggested process: minimum member thickness, internal corner radii, overhangs/support for AM, tool access for CNC, kerf for laser/waterjet. Name the features in the image you'd change.
### Next iteration
3 prioritized, actionable changes (to volume fraction, supports, keep-out/keep-in regions, material or thickness) with the expected effect.

Be quantitative where the numbers allow. Do not invent results you were not given. Keep it under 350 words.`;

export async function streamReview({ imageBase64, facts, onText, onReset, signal }) {
  const c = await getClient();
  try {
    const stream = c.beta.messages.stream(
      {
        model: MODEL,
        max_tokens: 16000,
        system: REVIEW_SYSTEM,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageBase64 } },
            { type: 'text', text: `<analysis_results>\n${facts}\n</analysis_results>\n\nReview this design.` },
          ],
        }],
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
        ...FALLBACK,
      },
      { signal },
    );
    let text = '';
    for await (const event of stream) {
      if (event.type === 'content_block_start' && event.content_block.type === 'fallback') {
        text = '';
        onReset?.();
      } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        text += event.delta.text;
        onText?.(event.delta.text);
      }
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') throw new ClaudeError('Claude declined to review this design.', 'refusal');
    if (final.stop_reason === 'max_tokens') onText?.('\n\n_…output truncated._');
    return text;
  } catch (err) {
    throw explain(err);
  }
}

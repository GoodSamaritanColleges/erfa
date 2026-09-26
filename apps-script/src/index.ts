import { dispatch, type ApiRequest } from './api';
import { bootstrapAdmin as bootstrap } from './auth';
import { setupSchema } from './store';
import { beginPerformance, performanceSnapshot, timed } from './performance';

function json(value: unknown): GoogleAppsScript.Content.TextOutput {
  const serialized = timed('serializationMs', () => JSON.stringify(value));
  const performance = performanceSnapshot();
  const output = timed('responsePreparationMs', () => ContentService.createTextOutput(performance
    ? JSON.stringify({ ...(value as Record<string, unknown>), performance }) : serialized).setMimeType(ContentService.MimeType.JSON));
  const final = performanceSnapshot();
  if (final) console.log('[eRFA PERF]', JSON.stringify(final));
  return output;
}

function doGet(event?: GoogleAppsScript.Events.DoGet): GoogleAppsScript.Content.TextOutput {
  beginPerformance(event?.parameter?.perf === '1');
  return json({ ok: true, data: dispatch({ action: 'health' }) });
}

function doPost(event: GoogleAppsScript.Events.DoPost): GoogleAppsScript.Content.TextOutput {
  const requestStarted = Date.now();
  beginPerformance(false);
  try {
    const request = JSON.parse(event?.postData?.contents || '{}') as ApiRequest;
    beginPerformance(request.performance === true, requestStarted);
    return json({ ok: true, data: dispatch(request) });
  } catch (error) {
    console.error(error instanceof Error ? error : String(error));
    const typed = error as Error & { code?: string };
    return json({ ok: false, error: { code: typed.code || 'SERVER_ERROR', message: typed.message || 'The request could not be completed.' } });
  }
}

function setupDatabase(): unknown {
  return setupSchema();
}

function bootstrapAdmin(email: string, fullName: string): unknown {
  setupSchema();
  return bootstrap(email, fullName);
}

// The production bundle keeps implementation code inside an IIFE. Store only
// intended Apps Script entry points here; build.mjs emits top-level forwarding
// declarations so Apps Script can discover them in the editor and Web App.
Object.assign(globalThis, { __erfaEntrypoints: { doGet, doPost, setupDatabase, bootstrapAdmin } });

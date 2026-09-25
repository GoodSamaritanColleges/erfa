import { dispatch, type ApiRequest } from './api';
import { bootstrapAdmin as bootstrap } from './auth';
import { setupSchema } from './store';

function json(value: unknown): GoogleAppsScript.Content.TextOutput {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(): GoogleAppsScript.Content.TextOutput {
  return json({ ok: true, data: dispatch({ action: 'health' }) });
}

function doPost(event: GoogleAppsScript.Events.DoPost): GoogleAppsScript.Content.TextOutput {
  try {
    const request = JSON.parse(event?.postData?.contents || '{}') as ApiRequest;
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

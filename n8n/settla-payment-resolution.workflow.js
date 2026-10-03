// n8n Workflow SDK source for "SETTLA - PAYMENT RESOLUTION" (n8n workflow id OegVTXtJIYo5upSV, INACTIVE).
// Reference copy for version control. See docs/N8N_INTEGRATION.md. Contains NO secrets.
//
// Webhook (Header Auth credential "Settla Webhook Header Auth")
//   -> Validate request (envelope checks only; NO business policy)
//   -> Request valid?  -- true  -> Extract case information -> Perform approved integration action (TEST placeholders) -> Respond success
//                      -- false -> Respond error (structured failure)
import { workflow, node, trigger, ifElse, newCredential, expr } from '@n8n/workflow-sdk';

const webhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.2,
  config: {
    name: 'Webhook',
    position: [0, 200],
    parameters: { httpMethod: 'POST', path: 'settla/payment-resolution', authentication: 'headerAuth', responseMode: 'responseNode', options: {} },
    credentials: { httpHeaderAuth: newCredential('Settla Webhook Header Auth') }
  }
});

const validateRequest = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Validate request',
    position: [240, 200],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `// Checks: timestamp window (300s), event id, correlation id, optional HMAC (only if SETTLA_N8N_SIGNING_SECRET is available),
// financial-action rejection, strict payload shape, backend authorisation (approved=true, not expired), best-effort replay guard.
// The Settla backend decides policy/risk/approval BEFORE calling; n8n never does. See contract in docs/N8N_INTEGRATION.md.`
    }
  }
});

// NOTE: the full jsCode bodies live in the n8n workflow itself (OegVTXtJIYo5upSV) and are mirrored, executably, by
// src/integrations/n8n/mockN8n.js which the backend test-suite exercises. Keep the two in sync when editing either.
void [webhook, validateRequest, ifElse, expr];

export default workflow('settla-payment-resolution', 'SETTLA - PAYMENT RESOLUTION');

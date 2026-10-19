/**
 * The Connect Hub stylesheet, injected once as a `<style>` tag keyed by the
 * plugin id. The client bundle is a standalone browser half (no CSS pipeline),
 * so the tag is the delivery channel; the insertion is idempotent so a
 * remount or a second registration cannot duplicate rules.
 *
 * All colors come from `--dsw-alias-*` semantic tokens so light and dark both
 * work; every transition is disabled under `prefers-reduced-motion`.
 */

const STYLE_ATTRIBUTE = 'data-dsh-connect-hub'
const STYLE_ID = 'dsh-connect-hub'

const CSS = `
.ch-root,
.ch-root * {
  box-sizing: border-box;
}
.ch-root {
  display: flex;
  flex-direction: column;
  gap: 16px;
  font-family: var(--dsw-font-family);
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
}
.ch-root button {
  font-family: inherit;
}
.ch-root :where(button, input, textarea, select, [tabindex]):focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.ch-caption { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary)); }
.ch-tabular { font-variant-numeric: tabular-nums; }
.ch-truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ch-grow { flex: 1; min-width: 0; }
.ch-row { display: flex; align-items: center; gap: 10px; min-width: 0; }
.ch-row-wrap { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ch-spacer { flex: 1; }
.ch-divider { height: 0.5px; flex: none; background: var(--dsw-alias-border-l2); }
.ch-sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

/* ---------- hub bar ---------- */
.ch-hubbar,
.ch-skeleton-bar {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px 8px 12px;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  border-radius: var(--dsw-radius-xl);
  background: var(--dsw-alias-settings-card-fill);
}
.ch-hubbar-main { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.ch-region { margin-left: auto; }
.ch-hubbar-side { display: flex; align-items: center; gap: 10px; min-height: 28px; }
.ch-families { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.ch-family {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 30px;
  padding: 0 11px;
  border: 0.5px solid transparent;
  border-radius: 999px;
  corner-shape: round;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 16px;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
}
.ch-family:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ch-family[data-active='true'] {
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 42%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 9%, transparent);
  color: var(--dsw-alias-label-primary);
}
.ch-family-name { font-weight: 500; }
.ch-family-state { color: var(--dsw-alias-label-tertiary); }
.ch-family[data-active='true'] .ch-family-state { color: var(--dsw-alias-label-secondary); }
.ch-label { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.ch-hint { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); max-width: 680px; }

/* ---------- cards ---------- */
.ch-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px 16px;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  border-radius: var(--dsw-radius-xl);
  background: var(--dsw-alias-settings-card-fill);
}
.ch-card-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.ch-card-title {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  font-weight: 600;
  letter-spacing: 0.1px;
}
.ch-card-icon { display: inline-flex; color: var(--dsw-alias-label-tertiary); }
.ch-card-meta {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
  white-space: nowrap;
}
.ch-sections { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.ch-split {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  align-items: start;
}
@media (max-width: 760px) {
  .ch-split { grid-template-columns: minmax(0, 1fr); }
}

/* ---------- feedback ---------- */
.ch-inline-note { display: flex; align-items: flex-start; gap: 6px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.ch-inline-note[data-tone='error'] { color: var(--dsw-alias-state-error-primary); }
.ch-inline-note[data-tone='success'] { color: var(--dsw-alias-state-success-primary); }
.ch-inline-note[data-tone='warn'] { color: var(--dsw-alias-state-warn-label, var(--dsw-alias-state-warn-primary)); }
.ch-inline-note svg { flex: none; margin-top: 2px; }
.ch-banner {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border-radius: var(--dsw-radius-md);
  font-size: 12px;
  line-height: 18px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
}
.ch-banner[data-tone='error'] {
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 55%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 7%, transparent);
  color: var(--dsw-alias-label-primary);
}
.ch-banner[data-tone='warn'] {
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 55%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, transparent);
  color: var(--dsw-alias-label-primary);
}
.ch-banner-icon { flex: none; display: inline-flex; margin-top: 1px; }
.ch-banner[data-tone='error'] .ch-banner-icon { color: var(--dsw-alias-state-error-primary); }
.ch-banner[data-tone='warn'] .ch-banner-icon { color: var(--dsw-alias-state-warn-primary); }
.ch-notice {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: var(--dsw-radius-md);
  font-size: 12px;
  line-height: 18px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
}
.ch-notice[data-tone='error'] { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent); }
.ch-notice[data-tone='success'] { color: var(--dsw-alias-state-success-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, transparent); }

/* ---------- tags / badges ---------- */
.ch-tag-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }

/* ---------- connection ---------- */
.ch-conn { display: flex; flex-direction: column; gap: 12px; }
.ch-id { display: flex; align-items: flex-start; gap: 10px; min-width: 0; }
.ch-id-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.ch-id-name {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
}
.ch-id-detail { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.ch-id-facts { display: flex; align-items: center; flex-wrap: wrap; gap: 3px 14px; margin-top: 3px; }
.ch-fact { display: inline-flex; align-items: baseline; gap: 5px; font-size: 11.5px; line-height: 16px; }
.ch-fact-label { color: var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary)); }
.ch-fact-value { color: var(--dsw-alias-label-secondary); }
.ch-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ch-pat { display: flex; flex-direction: column; gap: 8px; }
.ch-pat-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ch-pat-row > :first-child { flex: 0 1 420px; min-width: 220px; }

/* ---------- accounts ---------- */
.ch-acc-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.ch-acc-title { font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.ch-accounts { display: flex; flex-direction: column; gap: 4px; }
.ch-account {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 8px 10px;
  border-radius: var(--dsw-radius-md);
  border: 0.5px solid transparent;
  background: var(--dsw-alias-bg-layer-1);
  cursor: pointer;
  transition: border-color 120ms ease, background 120ms ease;
}
.ch-account:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ch-account[data-state='error'],
.ch-account[data-state='expired'] {
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 35%, transparent);
}
.ch-account[data-state='soon'] {
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 38%, transparent);
}
.ch-account[data-selected='true'] {
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 40%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 6%, transparent);
}
.ch-account-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.ch-account-name {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  min-width: 0;
  font-size: 12.5px;
  font-weight: 500;
}
.ch-account-facts { display: flex; align-items: center; flex-wrap: wrap; gap: 2px 14px; }
.ch-account-detail { font-size: 11.5px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
.ch-radio {
  appearance: none;
  width: 14px;
  height: 14px;
  margin: 0;
  flex: none;
  border-radius: 50%;
  corner-shape: round;
  border: 1px solid var(--dsw-alias-border-l4);
  background: transparent;
  cursor: pointer;
  display: inline-grid;
  place-items: center;
}
.ch-radio:checked { border-color: var(--dsw-alias-brand-primary); }
.ch-radio:checked::after {
  content: '';
  width: 7px;
  height: 7px;
  border-radius: 50%;
  corner-shape: round;
  background: var(--dsw-alias-brand-primary);
}
.ch-radio:disabled { opacity: 0.45; cursor: default; }

/* ---------- credits ---------- */
.ch-credit-hero { display: flex; align-items: flex-end; gap: 12px; flex-wrap: wrap; }
.ch-credit-value { display: flex; align-items: baseline; gap: 6px; }
.ch-credit-number { font-size: 28px; line-height: 32px; font-weight: 600; letter-spacing: -0.4px; font-variant-numeric: tabular-nums; }
.ch-credit-unit { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.ch-credit-side { display: flex; flex-direction: column; gap: 2px; align-items: flex-end; margin-left: auto; text-align: right; }
.ch-progress {
  position: relative;
  height: 6px;
  width: 100%;
  border-radius: 999px;
  corner-shape: round;
  background: color-mix(in srgb, var(--dsw-alias-label-tertiary) 16%, transparent);
  overflow: hidden;
}
.ch-progress > i {
  display: block;
  height: 100%;
  width: 0;
  min-width: 0;
  border-radius: inherit;
  background: var(--dsw-alias-state-business-primary);
  transition: width 240ms ease;
}
.ch-progress[data-tone='warn'] > i { background: var(--dsw-alias-state-warn-primary); }
.ch-progress[data-tone='danger'] > i { background: var(--dsw-alias-state-error-primary); }
.ch-packages { display: flex; flex-direction: column; gap: 10px; }
.ch-package { display: flex; flex-direction: column; gap: 5px; }
.ch-package-head { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.ch-package-name { font-weight: 500; }
.ch-package-meta { margin-left: auto; display: flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-tertiary); font-size: 11.5px; white-space: nowrap; }

/* ---------- models ---------- */
.ch-model-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ch-model-search { flex: 1 1 260px; min-width: 220px; }
.ch-model-toggles { display: flex; align-items: center; gap: 6px; flex: none; }
.ch-model-secondary { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.ch-model-secondary .ch-caption { flex: 1 1 260px; }
.ch-model-list { display: flex; flex-direction: column; gap: 2px; max-height: 420px; overflow: auto; margin: 0 -6px; padding: 2px 6px; }
.ch-model {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--dsw-radius-md);
  min-width: 0;
  transition: background 100ms ease;
}
.ch-model:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ch-model[data-enabled='false'] .ch-model-name { color: var(--dsw-alias-label-tertiary); }
.ch-model-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.ch-model-name { display: flex; align-items: center; gap: 6px; font-weight: 500; min-width: 0; }
.ch-model-id { font-size: 10.5px; line-height: 15px; color: var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary)); font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, monospace); }
.ch-model-badges { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.ch-model-side { display: flex; align-items: center; gap: 10px; flex: none; }
.ch-model-price { display: flex; flex-direction: column; align-items: flex-end; gap: 1px; min-width: 64px; }
.ch-model-price-value { font-size: 12px; font-weight: 500; font-variant-numeric: tabular-nums; }
.ch-model-price[data-unknown='true'] .ch-model-price-value { font-weight: 400; color: var(--dsw-alias-state-warn-label, var(--dsw-alias-label-tertiary)); }
.ch-max-context { display: flex; align-items: center; gap: 8px; }
.ch-max-context-title { font-size: 12px; font-weight: 500; }
.ch-empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 22px 16px; text-align: center; color: var(--dsw-alias-label-tertiary); }
.ch-empty svg { color: var(--dsw-alias-label-tertiary); }
.ch-empty-title { font-size: 12.5px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.ch-empty-body { font-size: 12px; line-height: 18px; max-width: 380px; }

/* ---------- check-in ---------- */
.ch-checkin-grid { display: flex; flex-direction: column; gap: 10px; }
.ch-checkin-controls { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.ch-checkin-time { display: flex; align-items: center; gap: 8px; }
.ch-checkin-time input { width: 112px; }
.ch-checkin-log { display: flex; flex-direction: column; gap: 2px; max-height: 180px; overflow: auto; margin: 0 -6px; padding: 2px 6px; }
.ch-log-row { display: grid; grid-template-columns: 96px 14px minmax(0, 1fr); align-items: center; gap: 8px; padding: 5px 8px; border-radius: var(--dsw-radius-sm); font-size: 12px; }
.ch-log-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ch-log-time { color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; font-size: 11.5px; }
.ch-log-ok { color: var(--dsw-alias-state-success-primary); display: inline-flex; }
.ch-log-fail { color: var(--dsw-alias-state-error-primary); display: inline-flex; }
.ch-log-message { color: var(--dsw-alias-label-secondary); min-width: 0; }

/* ---------- probes ---------- */
.ch-probe-list { display: flex; flex-direction: column; gap: 2px; }
.ch-probe {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 8px;
  border-radius: var(--dsw-radius-md);
  min-width: 0;
}
.ch-probe:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ch-probe-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.ch-probe-name { display: flex; align-items: center; gap: 6px; font-weight: 500; font-size: 12.5px; }
.ch-probe-message { font-size: 11.5px; line-height: 17px; color: var(--dsw-alias-label-tertiary); }
.ch-probe-action { flex: none; display: flex; align-items: center; gap: 8px; }
.ch-consent {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: var(--dsw-radius-md);
  border: 0.5px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
}
.ch-consent-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.ch-consent-title { font-size: 12.5px; font-weight: 500; }

/* ---------- transfer ---------- */
.ch-transfer { display: flex; flex-direction: column; gap: 10px; }
.ch-export-list { display: flex; flex-direction: column; gap: 4px; }
.ch-export-row { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: var(--dsw-radius-sm); font-size: 12px; }
.ch-export-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ch-transfer-textarea {
  width: 100%;
  min-height: 84px;
  max-height: 200px;
  resize: vertical;
  padding: 9px 11px;
  border-radius: var(--dsw-radius-md);
  border: 0.5px solid var(--dsw-alias-border-l3);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, monospace);
  font-size: 11.5px;
  line-height: 17px;
}
.ch-transfer-textarea::placeholder { color: var(--dsw-alias-label-tertiary); }
.ch-preview {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-radius: var(--dsw-radius-md);
  border: 0.5px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
}
.ch-preview-head { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.ch-preview-row { display: grid; grid-template-columns: 16px minmax(0, 1fr) auto auto; align-items: center; gap: 8px; padding: 4px 2px; font-size: 12px; }
.ch-preview-label { display: flex; flex-direction: column; min-width: 0; }
.ch-preview-id { font-size: 10.5px; color: var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary)); font-family: var(--ds-font-family-code, ui-monospace, monospace); }
.ch-check {
  appearance: none;
  width: 14px;
  height: 14px;
  margin: 0;
  border-radius: 4px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  background: transparent;
  display: inline-grid;
  place-items: center;
  cursor: pointer;
  flex: none;
}
.ch-check:checked { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.ch-check:checked::after {
  content: '';
  width: 8px;
  height: 5px;
  border-left: 1.6px solid var(--dsw-alias-label-primary-foreground);
  border-bottom: 1.6px solid var(--dsw-alias-label-primary-foreground);
  transform: rotate(-45deg) translateY(-1px);
}

/* ---------- warnings ---------- */
.ch-warnings { display: flex; flex-direction: column; gap: 6px; }
.ch-warning {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
  border: 0.5px solid var(--dsw-alias-border-l1);
  font-size: 12px;
  line-height: 18px;
}
.ch-warning-icon { flex: none; display: inline-flex; margin-top: 2px; }
.ch-warning[data-level='error'] .ch-warning-icon { color: var(--dsw-alias-state-error-primary); }
.ch-warning[data-level='warn'] .ch-warning-icon { color: var(--dsw-alias-state-warn-primary); }
.ch-warning[data-level='info'] .ch-warning-icon { color: var(--dsw-alias-label-tertiary); }
.ch-warning-message { flex: 1; min-width: 0; color: var(--dsw-alias-label-secondary); }
.ch-warning-time { flex: none; font-size: 11px; color: var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary)); }

/* ---------- preferences ---------- */
.ch-pref-row { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.ch-pref-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.ch-pref-title { font-size: 12.5px; font-weight: 500; }

/* ---------- skeleton ---------- */
.ch-skeleton {
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-skeleton);
  animation: ch-skeleton-pulse 1.6s ease-in-out infinite;
}
@keyframes ch-skeleton-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}
.ch-skeleton-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  border-radius: var(--dsw-radius-xl);
  background: var(--dsw-alias-settings-card-fill);
}

/* ---------- composer readout ---------- */
.ch-readout-wrap { display: inline-flex; align-items: center; }
.ch-readout {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  max-width: 100%;
  padding: 0 9px;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 16px;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.ch-readout:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.ch-readout[data-open='true'] { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.ch-readout-name { font-weight: 500; color: var(--dsw-alias-label-primary); white-space: nowrap; }
.ch-readout-sep { color: var(--dsw-alias-label-tertiary); }
.ch-readout-value { color: var(--dsw-alias-label-secondary); white-space: nowrap; font-variant-numeric: tabular-nums; }
.ch-readout-dot { color: var(--dsw-alias-state-success-primary); display: inline-flex; }
.ch-readout-dot[data-state='warn'] { color: var(--dsw-alias-state-warn-primary); }
.ch-readout-dot[data-state='error'] { color: var(--dsw-alias-state-error-primary); }
.ch-readout-dot[data-state='idle'] { color: var(--dsw-alias-label-tertiary); }
.ch-dock-row { display: flex; justify-content: flex-end; }
.ch-dock-row .ch-readout { background: var(--dsw-alias-bg-layer-2); }
.ch-monogram {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  flex: none;
  border-radius: 50%;
  corner-shape: round;
  background: var(--dsw-alias-bg-skeleton);
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
}
.ch-popover {
  position: fixed;
  z-index: 40;
  width: 320px;
  max-width: calc(100vw - 24px);
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  border: 0;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-specific-menu, var(--dsw-alias-bg-overlay));
  color: var(--dsw-alias-label-primary);
  box-shadow: var(--dsw-elevation-prominent, 0 12px 32px rgb(0 0 0 / 18%));
  -webkit-backdrop-filter: var(--dsw-menu-backdrop-filter, blur(18px));
  backdrop-filter: var(--dsw-menu-backdrop-filter, blur(18px));
  font-size: 12px;
  line-height: 18px;
}
.ch-popover-head { display: flex; align-items: center; gap: 8px; }
.ch-popover-title { font-size: 13px; font-weight: 600; flex: 1; min-width: 0; }
.ch-popover-body { display: flex; flex-direction: column; gap: 7px; }
.ch-popover-row { display: flex; align-items: baseline; gap: 10px; }
.ch-popover-key { flex: none; width: 64px; color: var(--dsw-alias-label-tertiary); }
.ch-popover-value { flex: 1; min-width: 0; color: var(--dsw-alias-label-primary); text-align: right; overflow-wrap: anywhere; }
.ch-popover-accounts { display: flex; flex-direction: column; gap: 4px; }
.ch-popover-account {
  display: flex; align-items: center; gap: 8px; padding: 5px 7px;
  border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-interactive-bg-hover);
}
.ch-popover-account[data-selected='true'] { outline: 0.5px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent); }
.ch-popover-account-name { flex: 1; min-width: 0; font-weight: 500; }
.ch-popover-actions { display: flex; align-items: center; gap: 8px; }
.ch-popover-error { font-size: 11.5px; color: var(--dsw-alias-state-error-primary); }

@media (prefers-reduced-motion: reduce) {
  .ch-root *,
  .ch-root *::before,
  .ch-root *::after {
    transition: none !important;
    animation: none !important;
  }
  .ch-skeleton { animation: none; }
}
`

/** Insert the plugin stylesheet once; returns an idempotent disposer. */
export function insertStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  const existing = document.querySelector(`style[${STYLE_ATTRIBUTE}="${STYLE_ID}"]`)
  if (existing !== null) return () => {}
  const tag = document.createElement('style')
  tag.setAttribute(STYLE_ATTRIBUTE, STYLE_ID)
  tag.textContent = CSS
  document.head.appendChild(tag)
  return () => { tag.remove() }
}

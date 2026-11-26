HAGEMI.css = `
:host { all: initial; }
.stage { position: fixed; left: 0; top: 0; pointer-events: none; will-change: transform; }
.layer { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.hit { position: absolute; pointer-events: auto; cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none; }
.hit:active { cursor: grabbing; }

.bubble {
  position: fixed; left: 0; top: 0; max-width: 248px; min-width: 40px; padding: 9px 13px 10px;
  background: #fffdfb; color: #2a1b3d; border: 2px solid #a78bfa; border-radius: 15px;
  font: 500 13px/1.5 "Segoe UI", "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif;
  box-shadow: 0 6px 22px rgba(46, 24, 104, 0.28); pointer-events: auto; cursor: pointer;
  opacity: 0; visibility: hidden; transition: opacity 0.16s ease, visibility 0.16s; word-break: break-word; white-space: pre-wrap;
}
.bubble.show { opacity: 1; visibility: visible; }
.bubble::after {
  content: ''; position: absolute; width: 11px; height: 11px; background: inherit;
  border-right: 2px solid #a78bfa; border-bottom: 2px solid #a78bfa; left: var(--tail-x, 50%); bottom: -7.5px;
  transform: translateX(-50%) rotate(45deg); border-bottom-right-radius: 3px;
}
.bubble[data-side="right"]::after { left: -7.5px; top: 18px; bottom: auto; transform: rotate(135deg); }
.bubble[data-side="left"]::after { left: auto; right: -7.5px; top: 18px; bottom: auto; transform: rotate(-45deg); }
.mark { color: #8b5cf6; font-weight: 700; margin-right: 4px; }
.mark:empty { display: none; }

.hud {
  position: fixed; left: 0; top: 0; min-width: 196px; padding: 8px 11px; display: grid; gap: 5px;
  background: rgba(32, 24, 58, 0.93); color: #efe9ff; border: 1px solid rgba(167, 139, 250, 0.55); border-radius: 11px;
  font: 500 11.5px/1.35 "Segoe UI", "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif;
  box-shadow: 0 6px 22px rgba(10, 4, 30, 0.42); pointer-events: none; opacity: 0; visibility: hidden; transition: opacity 0.14s ease;
}
.hud.show { opacity: 1; visibility: visible; }
.row { display: flex; align-items: center; gap: 7px; white-space: nowrap; }
.label { color: #c3b6ee; flex: 0 0 auto; }
.value { margin-left: auto; font-variant-numeric: tabular-nums; }
.meter { flex: 1 1 42px; min-width: 42px; height: 5px; border-radius: 3px; background: rgba(255, 255, 255, 0.16); overflow: hidden; }
.fill { display: block; height: 100%; border-radius: 3px; background: #fbbf24; }
.fill[data-tone="warn"] { background: #fb923c; }
.fill[data-tone="bad"] { background: #f43f5e; }

.menu {
  position: fixed; left: 0; top: 0; min-width: 176px; padding: 5px; background: #fffdfb; color: #2a1b3d;
  border: 1px solid #c4b5fd; border-radius: 11px; box-shadow: 0 10px 30px rgba(46, 24, 104, 0.32);
  font: 500 12.5px/1.3 "Segoe UI", "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif;
  pointer-events: auto; display: none;
}
.menu.show { display: block; }
.item { display: block; width: 100%; padding: 6px 10px; border: 0; background: none; color: inherit; font: inherit; text-align: left; border-radius: 7px; cursor: pointer; }
.item:hover, .item:focus-visible { background: #ede9fe; outline: none; }
.divider { height: 1px; margin: 4px 6px; background: #e9e3fb; }

.panel {
  position: fixed; left: 0; top: 0; width: 292px; max-height: min(78vh, 620px); overflow: auto; padding: 10px 13px 13px; display: none;
  background: #fffdfb; color: #2a1b3d; border: 1px solid #c4b5fd; border-radius: 13px; box-shadow: 0 12px 36px rgba(46, 24, 104, 0.34);
  font: 500 12.5px/1.35 "Segoe UI", "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif; pointer-events: auto;
}
.panel.show { display: block; }
.panel-head { display: flex; align-items: center; justify-content: space-between; font-size: 13.5px; margin-bottom: 4px; }
.panel-close { border: 0; background: none; color: inherit; font-size: 18px; line-height: 1; padding: 0 4px; cursor: pointer; border-radius: 6px; }
.panel-close:hover { background: #ede9fe; }
.panel-section { margin: 11px 0 5px; font-size: 11px; font-weight: 700; letter-spacing: 0.04em; color: #7c5cd6; }
.field { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 3px 0; }
.field > span { flex: 1 1 auto; }
.field select, .field input[type="number"], .field textarea {
  font: inherit; color: inherit; background: #faf8ff; border: 1px solid #d9cffb; border-radius: 7px; padding: 3px 6px; max-width: 148px;
}
.field input[type="number"] { width: 70px; }
.field input[type="checkbox"] { accent-color: #8b5cf6; width: 15px; height: 15px; }
.field textarea { width: 148px; resize: vertical; }
.panel-note { color: #6b5b95; }
.panel-note + .panel-note { margin-top: 5px; }
.panel-link { color: #7c3aed; margin-right: 12px; }
.update-card { margin: 10px 0; padding: 10px; border: 1px solid #dfd3fa; border-radius: 12px; background: linear-gradient(135deg, #f3edff, #fff3f7); }
.update-title { display: flex; align-items: center; flex-wrap: wrap; gap: 5px; }
.update-paw { font-size: 17px; }
.update-version { margin-left: auto; font-size: 10px; color: #786493; }
.update-status { margin: 5px 0 8px; }
.update-reason { margin-bottom: 8px; font-size: 11px; }
.update-button { width: 100%; border: 1px solid #bba0ec; border-radius: 16px; padding: 7px 10px; background: #ede0ff; color: #58308e; font: inherit; font-weight: 700; cursor: pointer; }
.update-button:hover:not(:disabled) { background: #e3cefc; }
.update-button:focus-visible { outline: 2px solid #8b5cf6; outline-offset: 2px; }
.update-button:disabled { cursor: default; opacity: .7; }
.panel-action {
  width: 100%; margin-top: 6px; border: 1px solid #c4b5fd; border-radius: 10px; padding: 6px 10px;
  background: #f5f0ff; color: #58308e; font: inherit; font-weight: 600; cursor: pointer;
}
.panel-action:hover { background: #ede5ff; }
.work-pill {
  position: fixed; left: 0; top: 0; max-width: 224px; padding: 4px 10px; display: none;
  align-items: center; gap: 6px; border-radius: 999px; border: 1px solid rgba(167, 139, 250, 0.72);
  background: rgba(34, 25, 62, 0.9); color: #f3eeff; box-shadow: 0 5px 16px rgba(16, 8, 42, 0.35);
  font: 600 11px/1.3 "Segoe UI", "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif;
  pointer-events: auto; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.work-pill.show { display: inline-flex; }
.work-pill:hover { background: rgba(48, 36, 86, 0.96); border-color: #c4b5fd; }
.work-pill::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: #a78bfa; flex: 0 0 auto; }
.work-pill[data-tone="waiting"] { border-color: #fbbf24; background: rgba(58, 36, 12, 0.92); color: #fef3c7; }
.work-pill[data-tone="waiting"]::before { background: #fbbf24; }
.work-pill[data-tone="done"] { border-color: #34d399; background: rgba(14, 48, 38, 0.92); color: #d1fae5; }
.work-pill[data-tone="done"]::before { background: #34d399; }
.work-pill[data-tone="error"] { border-color: #fb7185; background: rgba(62, 16, 30, 0.92); color: #ffe4e6; }
.work-pill[data-tone="error"]::before { background: #fb7185; }
`;

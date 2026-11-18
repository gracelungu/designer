// The probe runs inside every live frame on the canvas (Designer's preview proxy injects it).
// For a single Storybook story it turns the story page into a bare design object: no padding, a
// transparent background, the component sized to its own content (Hug) or to the layer (Fixed).
// It reports that size, the story's props (argTypes and args) and the rendered styles to the canvas,
// and applies prop changes from the Code panel through Storybook's own channel, without a reload.
export const PROBE_JS = String.raw`(function () {
  if (window.__designerProbe || window.parent === window) return;
  window.__designerProbe = true;
  var post = function (m) { try { m.source = 'designer-probe'; window.parent.postMessage(m, '*'); } catch (e) {} };
  var params = new URLSearchParams(location.search);
  var isStory = /iframe\.html$/.test(location.pathname) && !!params.get('id');
  var storyId = params.get('id');
  var mode = { hug: true, w: 0, h: 0 };

  function safe(v, depth) {
    depth = depth || 0;
    if (v === null || v === undefined) return v;
    var t = typeof v;
    if (t === 'string' || t === 'number' || t === 'boolean') return v;
    if (t === 'function' || t === 'symbol' || depth > 4) return undefined;
    if (v.$$typeof) return '[element]';
    if (Array.isArray(v)) return v.map(function (x) { return safe(x, depth + 1); });
    var o = {};
    for (var k in v) { if (Object.prototype.hasOwnProperty.call(v, k)) { var s = safe(v[k], depth + 1); if (s !== undefined) o[k] = s; } }
    return o;
  }
  function argTypesOf(at) {
    var out = {};
    for (var k in (at || {})) {
      var a = at[k] || {};
      var control = a.control && typeof a.control === 'object' ? a.control.type : a.control;
      var table = a.table || {};
      if (table.disable || a.control === false) continue;
      out[k] = {
        name: a.name || k,
        type: a.type && (a.type.name || a.type),
        control: control || null,
        options: Array.isArray(a.options) ? a.options.map(function (o) { return typeof o === 'object' ? JSON.stringify(safe(o)) : o; }) : (a.type && a.type.value && Array.isArray(a.type.value) ? a.type.value.map(function (x) { return x && x.value !== undefined ? x.value : x; }) : null),
        description: a.description || '',
        defaultValue: table.defaultValue && table.defaultValue.summary,
        category: table.category || null,
      };
    }
    return out;
  }

  var css = [
    'html,body{background:transparent!important;margin:0!important;padding:0!important;overflow:hidden!important;min-height:0!important;height:auto!important}',
    '.sb-show-main,.sb-main-padded,.sb-main-centered,.sb-main-fullscreen{padding:0!important;margin:0!important;display:block!important;min-height:0!important}',
    '#storybook-root,#root{position:absolute!important;left:0!important;top:0!important;margin:0!important;padding:0!important}',
    'html.designer-hug #storybook-root,html.designer-hug #root{width:max-content!important;height:max-content!important}',
    'html.designer-fixed #storybook-root>*,html.designer-fixed #root>*{width:100%!important;height:100%!important;box-sizing:border-box!important}',
    '#storybook-docs,.sb-preparing-story,.sb-preparing-docs,.sb-nopreview{display:none!important}',
  ].join('\n');

  function root() { return document.getElementById('storybook-root') || document.getElementById('root'); }
  var last = '';
  function measure() {
    var r = root();
    if (!r) return;
    var w, h;
    if (mode.hug) { var b = r.getBoundingClientRect(); w = Math.ceil(Math.max(b.width, r.scrollWidth)); h = Math.ceil(Math.max(b.height, r.scrollHeight)); }
    else { w = mode.w; h = mode.h; }
    var key = w + 'x' + h;
    if (key !== last && w > 0 && h > 0) { last = key; post({ type: 'size', w: w, h: h }); }
    sendStyles();
  }
  var lastStyles = '';
  function sendStyles() {
    var r = root();
    var el = r && r.firstElementChild;
    if (!el) return;
    var s = getComputedStyle(el);
    var pick = ['display', 'flexDirection', 'alignItems', 'justifyContent', 'gap', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'backgroundColor', 'backgroundImage', 'color', 'borderTopWidth', 'borderTopStyle', 'borderTopColor', 'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius', 'boxShadow', 'opacity', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textAlign', 'textTransform', 'width', 'height'];
    var out = { tag: el.tagName.toLowerCase(), className: typeof el.className === 'string' ? el.className.slice(0, 200) : '' };
    pick.forEach(function (k) { out[k] = s[k]; });
    var key = JSON.stringify(out);
    if (key !== lastStyles) { lastStyles = key; post({ type: 'styles', styles: out }); }
  }
  function applyMode() {
    var html = document.documentElement;
    html.classList.toggle('designer-hug', mode.hug);
    html.classList.toggle('designer-fixed', !mode.hug);
    var r = root();
    if (r) { r.style.width = mode.hug ? '' : mode.w + 'px'; r.style.height = mode.hug ? '' : mode.h + 'px'; }
    last = '';
    measure();
  }

  var channel = null;
  function sendStory(s, args) {
    if (!s) return;
    storyId = s.id || storyId;
    post({ type: 'story', storyId: storyId, title: s.title, name: s.name, argTypes: argTypesOf(s.argTypes), initialArgs: safe(s.initialArgs || {}), args: safe(args || s.args || s.initialArgs || {}) });
  }
  function hook() {
    channel = window.__STORYBOOK_ADDONS_CHANNEL__;
    if (!channel || !channel.on) { setTimeout(hook, 100); return; }
    channel.on('storyPrepared', function (p) { sendStory(p, p.args); });
    channel.on('storyArgsUpdated', function (p) { post({ type: 'args', args: safe(p.args) }); });
    channel.on('storyRendered', function () { setTimeout(measure, 0); });
    channel.on('storyErrored', function (p) { post({ type: 'error', message: (p && (p.title || p.description)) || 'The story failed to render' }); });
    channel.on('storyThrewException', function (p) { post({ type: 'error', message: (p && p.message) || 'The component threw an error' }); });
    channel.on('storyMissing', function () { post({ type: 'error', message: 'Storybook has no story with this id' }); });
    // The story may have been prepared before this ran.
    try {
      var preview = window.__STORYBOOK_PREVIEW__;
      var cur = preview && preview.currentRender && preview.currentRender.story;
      if (cur) sendStory(cur, preview.storyStore && preview.storyStore.args && preview.storyStore.args.get ? preview.storyStore.args.get(cur.id) : null);
    } catch (e) {}
  }

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.target !== 'designer-probe') return;
    if (d.type === 'hug') { mode = { hug: true, w: 0, h: 0 }; applyMode(); }
    else if (d.type === 'fixed-size') { mode = { hug: false, w: Math.round(d.w), h: Math.round(d.h) }; applyMode(); }
    else if (d.type === 'set-args' && channel && storyId) {
      if (d.reset) channel.emit('resetStoryArgs', { storyId: storyId });
      channel.emit('updateStoryArgs', { storyId: storyId, updatedArgs: d.args || {} });
    }
  });

  function start() {
    if (isStory) {
      var st = document.createElement('style');
      st.textContent = css;
      (document.head || document.documentElement).appendChild(st);
      applyMode();
      var ro = new ResizeObserver(measure);
      var watch = function () { var r = root(); if (r) { ro.observe(r); new MutationObserver(measure).observe(r, { childList: true, subtree: true, attributes: true, characterData: true }); } else setTimeout(watch, 100); };
      watch();
      hook();
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
    }
    post({ type: 'ready', story: isStory, storyId: storyId });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();`;

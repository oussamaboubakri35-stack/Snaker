(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);

  // Tiny DOM builder. Always uses textContent, so project data can never inject HTML.
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  };

  const LABELS = {
    video: 'Video editing',
    motion: 'Motion graphics',
    design: 'Graphic design',
    branding: 'Branding',
  };
  const ORDER = ['video', 'motion', 'design', 'branding'];

  const state = { projects: [], filter: 'all' };

  const hash = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

  const getJson = async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error('Request failed: ' + url);
    return r.json();
  };

  /* ---------- Static markup that contains no user data ---------- */
  const MARK_SVG =
    '<svg class="ph__mark" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 7.5c-3-2.6-11-2-11 4.5s10 3.5 10 9.5-8 7.5-12 4.5"/><circle cx="23.5" cy="8" r="1.5" fill="currentColor" stroke="none"/></svg>';
  const PLAY_SVG =
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4l14 8-14 8z"/></svg>';

  const fromHtml = (html) => {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstChild;
  };

  const placeholder = (project) => {
    const el = h('div', { class: 'ph', 'data-v': String(hash(project.id || project.title) % 3) });
    el.append(fromHtml(MARK_SVG));
    return el;
  };

  /* ---------- Profile ---------- */
  const linkItem = (label, href) =>
    h('li', {}, h('a', { href, target: '_blank', rel: 'noopener noreferrer', text: label }));

  function renderProfile(p) {
    document.title = `${p.name} | Designer and video editor`;
    $('#heroTitle').textContent = (p.headline || '').replace(/\*/g, '');
    $('#heroSub').textContent = p.subheadline || '';
    $('#footName').textContent = p.name;

    if (p.availability) $('#statusText').textContent = p.availability;
    else $('#status').hidden = true;

    const about = $('#aboutText');
    about.replaceChildren();
    String(p.about || '')
      .split(/\n{2,}/)
      .filter(Boolean)
      .forEach((para) => about.append(h('p', { text: para })));

    const tools = $('#tools');
    tools.replaceChildren(...(p.tools || []).map((t) => h('li', { text: t })));
    $('#toolsTitle').hidden = !(p.tools && p.tools.length);

    const contact = $('#contactLinks');
    contact.replaceChildren();
    if (p.email) {
      contact.append(
        h('li', {}, h('span', { text: 'Email' }), h('a', { href: 'mailto:' + p.email, text: p.email }))
      );
    }
    if (p.location) contact.append(h('li', {}, h('span', { text: 'Based in' }), p.location));
    for (const s of p.socials || []) {
      contact.append(
        h('li', {}, h('span', { text: s.label }),
          h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer', text: s.url.replace(/^https?:\/\/(www\.)?/, '') }))
      );
    }

    const foot = $('#footLinks');
    foot.replaceChildren(...(p.socials || []).map((s) => linkItem(s.label, s.url)));
  }

  /* ---------- Work grid ---------- */
  function renderFilters() {
    const counts = {};
    for (const p of state.projects) counts[p.category] = (counts[p.category] || 0) + 1;
    const cats = ORDER.filter((c) => counts[c]);
    const box = $('#filters');
    box.replaceChildren();
    if (cats.length < 2) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const make = (key, label, n) =>
      h('button', {
        class: 'filter',
        type: 'button',
        'aria-pressed': String(state.filter === key),
        onclick: () => {
          state.filter = key;
          renderFilters();
          renderGrid();
        },
      }, label, h('span', { class: 'filter__n', text: String(n) }));
    box.append(make('all', 'All', state.projects.length), ...cats.map((c) => make(c, LABELS[c], counts[c])));
  }

  function card(p) {
    const media = h('div', { class: 'card__media' });
    if (p.cover) {
      media.append(h('img', { src: p.cover, alt: '', loading: 'lazy', decoding: 'async' }));
    } else {
      media.append(placeholder(p));
    }
    if (p.video || p.embed) {
      const badge = h('span', { class: 'badge-play' });
      badge.append(fromHtml(PLAY_SVG));
      media.append(badge);
    }
    return h('button', { class: 'card', type: 'button', onclick: () => openProject(p) },
      media,
      h('span', { class: 'card__title', text: p.title }),
      h('span', { class: 'card__meta', text: `${LABELS[p.category] || p.category}, ${p.year}` })
    );
  }

  function renderGrid() {
    const grid = $('#grid');
    const list = state.projects.filter((p) => state.filter === 'all' || p.category === state.filter);
    $('#workCount').textContent = state.projects.length
      ? `${state.projects.length} ${state.projects.length === 1 ? 'project' : 'projects'}`
      : '';
    grid.replaceChildren();
    if (!list.length) {
      grid.append(h('p', { class: 'empty', text: 'No projects here yet. Check back soon, or get in touch to see more.' }));
      return;
    }
    list.forEach((p) => grid.append(card(p)));
  }

  /* ---------- Viewer ---------- */
  const viewer = $('#viewer');
  const vMedia = $('#vMedia');

  function openProject(p) {
    vMedia.replaceChildren();
    if (p.video) {
      const v = h('video', { controls: true, playsinline: true, preload: 'metadata', src: p.video });
      if (p.cover) v.setAttribute('poster', p.cover);
      vMedia.append(v);
    } else if (p.embed) {
      vMedia.append(h('iframe', {
        src: p.embed,
        title: p.title,
        allow: 'accelerometer; encrypted-media; picture-in-picture; fullscreen',
        allowfullscreen: true,
        loading: 'lazy',
        referrerpolicy: 'strict-origin-when-cross-origin',
      }));
    } else if (p.cover) {
      vMedia.append(h('img', { src: p.cover, alt: p.title }));
    } else {
      vMedia.append(placeholder(p));
    }
    $('#vMeta').textContent = `${LABELS[p.category] || p.category}, ${p.year}`;
    $('#vTitle').textContent = p.title;
    $('#vDesc').textContent = p.description || '';
    $('#vDesc').hidden = !p.description;
    $('#vTags').replaceChildren(...(p.tags || []).map((t) => h('li', { text: t })));
    viewer.showModal();
  }

  $('#vClose').addEventListener('click', () => viewer.close());
  viewer.addEventListener('click', (e) => { if (e.target === viewer) viewer.close(); });
  viewer.addEventListener('close', () => vMedia.replaceChildren()); // stops playback

  /* ---------- Nav, theme ---------- */
  const nav = $('#nav');
  const burger = $('#burger');
  burger.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    burger.setAttribute('aria-expanded', String(open));
  });
  $('#menu').addEventListener('click', (e) => {
    if (e.target.closest('a')) {
      nav.classList.remove('open');
      burger.setAttribute('aria-expanded', 'false');
    }
  });

  $('#themeBtn').addEventListener('click', () => {
    const root = document.documentElement;
    const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('snaker-theme', next); } catch (e) { /* storage unavailable */ }
  });

  $('#year').textContent = new Date().getFullYear();

  /* ---------- Contact form ---------- */
  const form = $('#contactForm');
  const status = $('#cStatus');
  const setStatus = (text, state) => {
    status.textContent = text;
    status.dataset.state = state || '';
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    if (!data.name.trim() || !data.email.trim() || !data.message.trim()) {
      return setStatus('Fill in your name, email and a short message.', 'err');
    }
    const btn = $('#cBtn');
    btn.disabled = true;
    setStatus('Sending...', '');
    try {
      const r = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(data),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || 'Could not send. Try again in a moment.');
      form.reset();
      setStatus('Message sent. I will reply by email soon.', 'ok');
    } catch (err) {
      setStatus(err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  });

  /* ---------- Boot ---------- */
  (async () => {
    try {
      const [profile, projects] = await Promise.all([getJson('/api/profile'), getJson('/api/projects')]);
      renderProfile(profile);
      state.projects = projects;
      renderFilters();
      renderGrid();
    } catch (err) {
      $('#grid').replaceChildren(
        h('p', { class: 'empty', text: 'Projects could not load. Refresh the page, or check that the server is running.' })
      );
    }
  })();
})();

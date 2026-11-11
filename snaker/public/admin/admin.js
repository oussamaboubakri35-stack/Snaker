(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
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

  const LABELS = { video: 'Video editing', motion: 'Motion graphics', design: 'Graphic design', branding: 'Branding' };
  const MARK_SVG =
    '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 7.5c-3-2.6-11-2-11 4.5s10 3.5 10 9.5-8 7.5-12 4.5"/></svg>';

  let editingId = null;
  const media = { cover: '', video: '' };
  let projects = [];

  /* ---------- API ---------- */
  async function api(url, { method = 'GET', body } = {}) {
    const opts = { method, headers: { 'x-snaker': '1' }, credentials: 'same-origin' };
    if (body !== undefined) {
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    let data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function upload(file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload?filename=' + encodeURIComponent(file.name));
      xhr.setRequestHeader('x-snaker', '1');
      xhr.setRequestHeader('content-type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch (e) { /* ignore */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(Object.assign(new Error(data.error || 'Upload failed'), { status: xhr.status }));
      };
      xhr.onerror = () => reject(new Error('Network error during upload'));
      xhr.send(file);
    });
  }

  const status = (id, text, state) => {
    const el = $(id);
    el.textContent = text;
    el.dataset.state = state || '';
  };

  // Any call that returns 401 sends you back to the login screen.
  async function guard(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err.status === 401) return showLogin('Your session ended. Log in again.');
      throw err;
    }
  }

  /* ---------- Login / logout ---------- */
  function showLogin(message) {
    $('#app').hidden = true;
    $('#logout').hidden = true;
    $('#login').hidden = false;
    $('#loginErr').textContent = message || '';
    $('#pw').focus();
  }

  async function showApp() {
    $('#login').hidden = true;
    $('#app').hidden = false;
    $('#logout').hidden = false;
    await guard(() => Promise.all([loadProjects(), loadMessages(), loadProfile()]));
  }

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/login', { method: 'POST', body: { password: $('#pw').value } });
      $('#pw').value = '';
      showApp();
    } catch (err) {
      $('#loginErr').textContent = err.message;
    }
  });

  $('#logout').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST', body: {} }).catch(() => {});
    showLogin('');
  });

  /* ---------- Tabs ---------- */
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
      for (const name of ['projects', 'messages', 'profile']) {
        $('#tab-' + name).hidden = name !== tab.dataset.tab;
      }
    });
  });

  /* ---------- Projects ---------- */
  function refreshMedia() {
    $('#pCoverInfo').replaceChildren(
      media.cover ? h('img', { class: 'thumb', src: media.cover, alt: 'Cover preview' }) : 'No cover yet. Projects without one show a plain placeholder.'
    );
    $('#pCoverClear').hidden = !media.cover;
    $('#pVideoInfo').textContent = media.video ? 'Video uploaded.' : 'No video file.';
    $('#pVideoClear').hidden = !media.video;
  }

  function resetForm() {
    editingId = null;
    $('#projectForm').reset();
    $('#pYear').value = new Date().getFullYear();
    media.cover = '';
    media.video = '';
    refreshMedia();
    $('#formTitle').textContent = 'Add a project';
    $('#pSave').textContent = 'Add project';
    $('#pCancel').hidden = true;
  }

  function editProject(p) {
    editingId = p.id;
    $('#pTitle').value = p.title;
    $('#pCategory').value = p.category;
    $('#pYear').value = p.year;
    $('#pTags').value = (p.tags || []).join(', ');
    $('#pDesc').value = p.description || '';
    $('#pEmbed').value = p.embed || '';
    media.cover = p.cover || '';
    media.video = p.video || '';
    refreshMedia();
    $('#formTitle').textContent = 'Edit project';
    $('#pSave').textContent = 'Save changes';
    $('#pCancel').hidden = false;
    status('#pStatus', '');
    $('#projectForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('#pTitle').focus();
  }

  async function loadProjects() {
    projects = await api('/api/projects');
    const list = $('#projectList');
    list.replaceChildren();
    if (!projects.length) {
      list.append(h('p', { class: 'empty-box', text: 'No projects yet. Add your first one above.' }));
      return;
    }
    for (const p of projects) {
      const thumb = p.cover
        ? h('div', { class: 'item__thumb' }, h('img', { src: p.cover, alt: '' }))
        : (() => {
            const t = h('div', { class: 'item__thumb ph', 'data-v': '0' });
            const tpl = document.createElement('template');
            tpl.innerHTML = MARK_SVG;
            t.append(tpl.content.firstChild);
            return t;
          })();
      list.append(
        h('div', { class: 'item' },
          thumb,
          h('div', {},
            h('div', { class: 'item__title', text: p.title }),
            h('div', { class: 'item__meta', text: `${LABELS[p.category] || p.category}, ${p.year}${p.sample ? ', sample' : ''}` })
          ),
          h('div', { class: 'item__btns' },
            h('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: 'Edit', onclick: () => editProject(p) }),
            h('button', {
              class: 'btn btn--ghost btn--sm btn--danger', type: 'button', text: 'Delete',
              onclick: async () => {
                if (!confirm(`Delete "${p.title}"? Its uploaded files are removed too.`)) return;
                try {
                  await guard(() => api('/api/projects/' + p.id, { method: 'DELETE' }));
                  if (editingId === p.id) resetForm();
                  await guard(loadProjects);
                } catch (err) { status('#pStatus', err.message, 'err'); }
              },
            })
          )
        )
      );
    }
  }

  async function handleFile(input, kind) {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    const prog = $('#pProgress');
    prog.hidden = false;
    prog.value = 0;
    $('#pSave').disabled = true;
    status('#pStatus', `Uploading ${file.name}...`);
    try {
      const { url } = await guard(() => upload(file, (f) => { prog.value = f; }));
      media[kind] = url;
      refreshMedia();
      status('#pStatus', 'Upload finished. Save the project to publish it.', 'ok');
    } catch (err) {
      status('#pStatus', err.message, 'err');
    } finally {
      prog.hidden = true;
      $('#pSave').disabled = false;
    }
  }

  $('#pCoverFile').addEventListener('change', (e) => handleFile(e.target, 'cover'));
  $('#pVideoFile').addEventListener('change', (e) => handleFile(e.target, 'video'));
  $('#pCoverClear').addEventListener('click', () => { media.cover = ''; refreshMedia(); });
  $('#pVideoClear').addEventListener('click', () => { media.video = ''; refreshMedia(); });
  $('#pCancel').addEventListener('click', () => { resetForm(); status('#pStatus', ''); });

  $('#projectForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      title: $('#pTitle').value,
      category: $('#pCategory').value,
      year: Number($('#pYear').value),
      description: $('#pDesc').value,
      tags: $('#pTags').value.split(',').map((t) => t.trim()).filter(Boolean),
      cover: media.cover,
      video: media.video,
      embed: $('#pEmbed').value.trim(),
    };
    if (!body.title.trim()) return status('#pStatus', 'Add a title first.', 'err');
    $('#pSave').disabled = true;
    try {
      const wasEditing = Boolean(editingId);
      await guard(() =>
        editingId
          ? api('/api/projects/' + editingId, { method: 'PUT', body })
          : api('/api/projects', { method: 'POST', body })
      );
      resetForm();
      await guard(loadProjects);
      status('#pStatus', wasEditing ? 'Changes saved.' : 'Project added. It is live on your site.', 'ok');
    } catch (err) {
      status('#pStatus', err.message, 'err');
    } finally {
      $('#pSave').disabled = false;
    }
  });

  /* ---------- Messages ---------- */
  async function loadMessages() {
    const msgs = await api('/api/messages');
    $('#msgCount').textContent = msgs.length ? String(msgs.length) : '';
    const list = $('#messageList');
    list.replaceChildren();
    if (!msgs.length) {
      list.append(h('p', { class: 'empty-box', text: 'No messages yet. New ones from your contact form show up here.' }));
      return;
    }
    for (const m of msgs) {
      list.append(
        h('article', { class: 'msg' },
          h('div', { class: 'msg__top' },
            h('span', { class: 'msg__name', text: `${m.name} (${m.email})` }),
            h('span', { class: 'msg__date', text: new Date(m.createdAt).toLocaleString() })
          ),
          h('p', { class: 'msg__body', text: m.message }),
          h('div', { class: 'msg__btns' },
            h('a', { class: 'btn btn--sm', href: 'mailto:' + m.email, text: 'Reply by email' }),
            h('button', {
              class: 'btn btn--ghost btn--sm btn--danger', type: 'button', text: 'Delete',
              onclick: async () => {
                if (!confirm('Delete this message?')) return;
                await guard(() => api('/api/messages/' + m.id, { method: 'DELETE' }));
                await guard(loadMessages);
              },
            })
          )
        )
      );
    }
  }

  /* ---------- Profile ---------- */
  async function loadProfile() {
    const p = await api('/api/profile');
    $('#fName').value = p.name || '';
    $('#fAvail').value = p.availability || '';
    $('#fHeadline').value = p.headline || '';
    $('#fSub').value = p.subheadline || '';
    $('#fAbout').value = p.about || '';
    $('#fEmail').value = p.email || '';
    $('#fLocation').value = p.location || '';
    $('#fTools').value = (p.tools || []).join(', ');
    $('#fSocials').value = (p.socials || []).map((s) => `${s.label} | ${s.url}`).join('\n');
  }

  $('#profileForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const socials = $('#fSocials').value
      .split('\n')
      .map((line) => {
        const i = line.indexOf('|');
        return i > -1 ? { label: line.slice(0, i).trim(), url: line.slice(i + 1).trim() } : null;
      })
      .filter(Boolean);
    const body = {
      name: $('#fName').value,
      availability: $('#fAvail').value,
      headline: $('#fHeadline').value,
      subheadline: $('#fSub').value,
      about: $('#fAbout').value,
      email: $('#fEmail').value,
      location: $('#fLocation').value,
      tools: $('#fTools').value.split(',').map((t) => t.trim()).filter(Boolean),
      socials,
    };
    try {
      await guard(() => api('/api/profile', { method: 'PUT', body }));
      status('#fStatus', 'Profile saved. Refresh your site to see it.', 'ok');
    } catch (err) {
      status('#fStatus', err.message, 'err');
    }
  });

  /* ---------- Boot ---------- */
  resetForm();
  (async () => {
    try {
      const me = await api('/api/me');
      if (me.admin) showApp();
      else showLogin('');
    } catch (err) {
      showLogin('Could not reach the server. Is it running?');
    }
  })();
})();

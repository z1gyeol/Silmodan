'use strict';

const NAME_PRESETS = {
  korean: ['평가원 모의평가', '교육청 학력평가', '수능', '이감', '상상', '한수', '바탕', '더프리미엄', '시대인재', '강대 K'],
  math: ['평가원 모의평가', '교육청 학력평가', '수능', '시대인재 서바이벌', '강대 K', '이해원', '한수', '상상', '더프리미엄', '킬링캠프'],
};
const CUSTOM = '__custom__';

const state = {
  user: null,
  subjects: null,
  subject: 'korean',
  exams: [], // 오래된 순
  allNames: { korean: new Set(), math: new Set() },
  editing: null,
  form: { subject: 'korean', wrong: new Set(), notes: new Set() },
};

let chart = null;

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') {
    showAuth();
  }
  if (!res.ok) throw new Error(data.error || '요청에 실패했습니다.');
  return data;
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 2200);
}

// ---------- 인증 ----------
let authMode = 'login';

function showAuth() {
  state.user = null;
  $('#app-view').hidden = true;
  $('#auth-view').hidden = false;
}

function setAuthMode(mode) {
  authMode = mode;
  document.querySelectorAll('.auth-tabs .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('#auth-submit').textContent = mode === 'login' ? '로그인' : '회원가입';
  $('#auth-form').password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('#auth-error').hidden = true;
}

document.querySelectorAll('.auth-tabs .seg-btn').forEach((b) => b.addEventListener('click', () => setAuthMode(b.dataset.mode)));

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const btn = $('#auth-submit');
  btn.disabled = true;
  try {
    const { user } = await api(authMode === 'login' ? '/api/login' : '/api/register', {
      method: 'POST',
      body: { username: form.username.value, password: form.password.value },
    });
    form.reset();
    await enterApp(user);
  } catch (err) {
    $('#auth-error').textContent = err.message;
    $('#auth-error').hidden = false;
  } finally {
    btn.disabled = false;
  }
});

$('#logout-btn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  showAuth();
});

async function enterApp(user) {
  state.user = user;
  $('#username').textContent = `${user.username} 님`;
  $('#auth-view').hidden = true;
  $('#app-view').hidden = false;
  await loadExams();
}

// ---------- 데이터 ----------
async function loadExams() {
  const { exams } = await api('/api/exams');
  state.allNames = { korean: new Set(), math: new Set() };
  exams.forEach((e) => state.allNames[e.subject].add(e.examName));
  state.exams = exams.filter((e) => e.subject === state.subject);
  render();
}

function examLabel(e) {
  const yy = String(e.schoolYear).slice(2);
  return `${yy}학년도 ${e.examName}${e.round ? ' ' + e.round : ''}`;
}

function formatDate(d) {
  if (!d) return null;
  const [y, m, day] = d.split('-');
  return `${y}.${m}.${day}`;
}

// ---------- 렌더 ----------
function render() {
  renderStats();
  renderChart();
  renderNoteStats();
  renderWrongStats();
  renderTable();
}

function renderStats() {
  const ex = state.exams;
  const scores = ex.map((e) => e.score);
  const n = scores.length;
  const avg = n ? scores.reduce((a, b) => a + b, 0) / n : null;
  const last5 = scores.slice(-5);
  const avg5 = last5.length ? last5.reduce((a, b) => a + b, 0) / last5.length : null;
  const maxIdx = n ? scores.indexOf(Math.max(...scores)) : -1;
  const minIdx = n ? scores.indexOf(Math.min(...scores)) : -1;
  const latest = ex[n - 1];
  const fmt = (v) => (v === null ? '-' : Number.isInteger(v) ? v : v.toFixed(1));

  const tiles = [
    { label: '최근 점수', value: latest ? latest.score : '-', unit: latest ? '점' : '', sub: latest ? examLabel(latest) : '기록 없음', hl: true },
    { label: '평균', value: fmt(avg), unit: n ? '점' : '', sub: `총 ${n}회 응시` },
    { label: '최근 5회 평균', value: fmt(avg5), unit: n ? '점' : '', sub: n ? `최근 ${last5.length}회 기준` : '-' },
    { label: '최고 점수', value: n ? scores[maxIdx] : '-', unit: n ? '점' : '', sub: n ? examLabel(ex[maxIdx]) : '-' },
    { label: '최저 점수', value: n ? scores[minIdx] : '-', unit: n ? '점' : '', sub: n ? examLabel(ex[minIdx]) : '-' },
  ];
  $('#stats').innerHTML = tiles
    .map(
      (t) => `<div class="stat${t.hl ? ' highlight' : ''}">
        <div class="stat-label">${t.label}</div>
        <div class="stat-value">${esc(t.value)}<small>${t.unit}</small></div>
        <div class="stat-sub" title="${esc(t.sub)}">${esc(t.sub)}</div>
      </div>`
    )
    .join('');
}

function renderChart() {
  const ex = state.exams;
  $('#chart-empty').hidden = ex.length > 0;
  $('#chart-caption').textContent = ex.length ? `오래된 시험 → 최근 시험 (${ex.length}회)` : '';

  const labels = ex.map((e) => examLabel(e));
  const data = ex.map((e) => e.score);
  const minScore = data.length ? Math.min(...data) : 0;

  if (!chart) {
    chart = new Chart($('#score-chart'), {
      type: 'line',
      data: { labels: [], datasets: [] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        layout: { padding: { top: 8, right: 8 } },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#2a1f4a',
            padding: 12,
            cornerRadius: 10,
            displayColors: false,
            titleFont: { family: 'Noto Sans KR', weight: '700' },
            bodyFont: { family: 'Noto Sans KR' },
            callbacks: {
              title: (items) => examLabel(chart.$exams[items[0].dataIndex]),
              label: (item) => {
                const e = chart.$exams[item.dataIndex];
                const lines = [`점수: ${e.score}점`, `날짜: ${e.examDate ? formatDate(e.examDate) : '날짜 모름'}`];
                if (e.wrong.length) lines.push(`틀린 문제: ${e.wrong.join(', ')}`);
                if (e.notes.length) lines.push(`비고: ${e.notes.join(', ')}`);
                return lines;
              },
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            border: { color: '#e6e0f3' },
            ticks: { color: '#8a83a0', font: { family: 'Noto Sans KR', size: 11 }, maxRotation: 0, autoSkip: true, autoSkipPadding: 16 },
          },
          y: {
            grid: { color: '#f0ecf8' },
            border: { display: false },
            ticks: { color: '#8a83a0', font: { family: 'Noto Sans KR', size: 11 }, stepSize: 10 },
            max: 100,
          },
        },
      },
    });
  }

  chart.$exams = ex;
  chart.data.labels = labels.map((l) => (l.length > 14 ? l.slice(0, 13) + '…' : l));
  chart.data.datasets = [
    {
      label: '점수',
      data,
      borderColor: '#7c3aed',
      borderWidth: 2,
      tension: 0.25,
      fill: true,
      backgroundColor: (ctx) => {
        const { chartArea, ctx: c } = ctx.chart;
        if (!chartArea) return 'rgba(124,58,237,.08)';
        const g = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
        g.addColorStop(0, 'rgba(124,58,237,.22)');
        g.addColorStop(1, 'rgba(124,58,237,0)');
        return g;
      },
      pointRadius: 4,
      pointHoverRadius: 6,
      pointBackgroundColor: '#fff',
      pointBorderColor: '#7c3aed',
      pointBorderWidth: 2,
      pointHitRadius: 12,
    },
  ];
  chart.options.scales.y.min = Math.max(0, Math.floor((minScore - 10) / 10) * 10);
  chart.update();
}

function renderNoteStats() {
  const notes = state.subjects[state.subject].notes;
  const ex = state.exams;
  if (!ex.length) {
    $('#note-stats').innerHTML = '<p class="empty">기록이 없습니다.</p>';
    return;
  }
  const counts = notes.map((n) => ex.filter((e) => e.notes.includes(n)).length);
  const max = Math.max(1, ...counts);
  $('#note-stats').innerHTML =
    notes
      .map(
        (n, i) => `<div class="bar-row">
          <span>${esc(n)}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${(counts[i] / max) * 100}%"></div></div>
          <span class="bar-count">${counts[i]}회</span>
        </div>`
      )
      .join('') + `<p class="muted small" style="margin:6px 0 0">전체 ${ex.length}회 중 해당 비고가 체크된 횟수</p>`;
}

function renderWrongStats() {
  const counts = new Map();
  state.exams.forEach((e) => e.wrong.forEach((q) => counts.set(q, (counts.get(q) || 0) + 1)));
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 12);
  if (!top.length) {
    $('#wrong-stats').innerHTML = '<p class="empty">틀린 문제 기록이 없습니다.</p>';
    return;
  }
  const avgWrong = state.exams.reduce((a, e) => a + e.wrong.length, 0) / state.exams.length;
  $('#wrong-stats').innerHTML =
    `<div class="wrong-list">${top.map(([q, c]) => `<div class="wrong-item"><b>${q}번</b><span>${c}회</span></div>`).join('')}</div>
     <p class="muted small" style="margin:12px 0 0">시험당 평균 ${avgWrong.toFixed(1)}문제 틀림</p>`;
}

function renderTable() {
  const ex = state.exams;
  $('#records-empty').hidden = ex.length > 0;
  const unknown = ex.filter((e) => !e.examDate);
  const rows = [...ex].reverse(); // 최근 시험이 위로
  $('#records-body').innerHTML = rows
    .map((e) => {
      const isUnknown = !e.examDate;
      const uIdx = isUnknown ? unknown.indexOf(e) : -1;
      const moveBtns = isUnknown
        ? `<button class="act" data-act="newer" data-id="${e.id}" title="더 최근으로" ${uIdx === unknown.length - 1 ? 'disabled' : ''}>▲</button>
           <button class="act" data-act="older" data-id="${e.id}" title="더 예전으로" ${uIdx === 0 ? 'disabled' : ''}>▼</button>`
        : '';
      return `<tr>
        <td>${isUnknown ? '<span class="badge badge-unknown">날짜 모름</span>' : esc(formatDate(e.examDate))}</td>
        <td><span class="badge">${e.schoolYear}</span></td>
        <td>${esc(e.examName)}</td>
        <td>${esc(e.round || '-')}</td>
        <td class="num score-cell">${e.score}</td>
        <td class="wrong-cell">${e.wrong.length ? esc(e.wrong.join(', ')) : '<span class="muted">-</span>'}</td>
        <td>${e.notes.length ? e.notes.map((n) => `<span class="note-tag">${esc(n)}</span>`).join('') : '<span class="muted">-</span>'}</td>
        <td><div class="actions">${moveBtns}
          <button class="act" data-act="edit" data-id="${e.id}">수정</button>
          <button class="act danger" data-act="delete" data-id="${e.id}">삭제</button>
        </div></td>
      </tr>`;
    })
    .join('');
}

$('#records-body').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const exam = state.exams.find((e) => e.id === id);
  try {
    if (btn.dataset.act === 'edit') return openDialog(exam);
    if (btn.dataset.act === 'delete') {
      if (!confirm(`'${examLabel(exam)}' 기록을 삭제할까요?`)) return;
      await api(`/api/exams/${id}`, { method: 'DELETE' });
      toast('삭제했습니다.');
    } else {
      await api(`/api/exams/${id}/move`, { method: 'POST', body: { direction: btn.dataset.act } });
    }
    await loadExams();
  } catch (err) {
    toast(err.message);
  }
});

// ---------- 과목 탭 ----------
document.querySelectorAll('#subject-tabs .seg-btn').forEach((b) =>
  b.addEventListener('click', () => {
    state.subject = b.dataset.subject;
    document.querySelectorAll('#subject-tabs .seg-btn').forEach((x) => x.classList.toggle('active', x === b));
    loadExams().catch((err) => toast(err.message));
  })
);

// ---------- 입력 모달 ----------
const dialog = $('#exam-dialog');

function defaultSchoolYear() {
  // 11월(수능) 이후에는 다음 학년도 시험지를 주로 풀기 때문에 +2
  const now = new Date();
  return now.getFullYear() + (now.getMonth() >= 10 ? 2 : 1);
}

function fillYearOptions(selected) {
  const top = new Date().getFullYear() + 2;
  const years = [];
  for (let y = top; y >= 2010; y--) years.push(y);
  if (!years.includes(selected)) years.push(selected);
  $('#f-year').innerHTML = years.map((y) => `<option value="${y}" ${y === selected ? 'selected' : ''}>${y}학년도</option>`).join('');
}

function fillNameOptions(subject, selected) {
  const presets = NAME_PRESETS[subject];
  const custom = [...state.allNames[subject]].filter((n) => !presets.includes(n)).sort();
  const sel = $('#f-name-select');
  let html = '<option value="">선택하세요</option>';
  html += `<optgroup label="기본">${presets.map((n) => `<option>${esc(n)}</option>`).join('')}</optgroup>`;
  if (custom.length) html += `<optgroup label="내가 입력한 이름">${custom.map((n) => `<option>${esc(n)}</option>`).join('')}</optgroup>`;
  html += `<option value="${CUSTOM}">✏️ 직접 입력</option>`;
  sel.innerHTML = html;
  if (selected && [...presets, ...custom].includes(selected)) sel.value = selected;
  else if (selected) {
    sel.value = CUSTOM;
    $('#f-name-custom').value = selected;
  } else sel.value = '';
  $('#f-name-custom-wrap').hidden = sel.value !== CUSTOM;
}

$('#f-name-select').addEventListener('change', (e) => {
  const isCustom = e.target.value === CUSTOM;
  $('#f-name-custom-wrap').hidden = !isCustom;
  if (isCustom) $('#f-name-custom').focus();
});

function setFormSubject(subject, keepName) {
  const prevName = keepName ? currentName() : '';
  state.form.subject = subject;
  document.querySelectorAll('#form-subject .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.subject === subject));
  const conf = state.subjects[subject];
  // 범위를 벗어난 문항 / 해당 과목에 없는 비고는 제거
  state.form.wrong = new Set([...state.form.wrong].filter((q) => q <= conf.maxQuestion));
  state.form.notes = new Set([...state.form.notes].filter((n) => conf.notes.includes(n)));
  fillNameOptions(subject, prevName);
  renderQGrid();
  renderNoteChips();
}

function currentName() {
  const v = $('#f-name-select').value;
  return v === CUSTOM ? $('#f-name-custom').value.trim() : v;
}

function renderQGrid() {
  const max = state.subjects[state.form.subject].maxQuestion;
  let html = '';
  for (let q = 1; q <= max; q++) html += `<button type="button" class="qbtn${state.form.wrong.has(q) ? ' on' : ''}" data-q="${q}">${q}</button>`;
  $('#f-wrong').innerHTML = html;
  $('#wrong-count').textContent = state.form.wrong.size ? `${state.form.wrong.size}문제 선택` : '(번호를 눌러 선택)';
}

function renderNoteChips() {
  $('#f-notes').innerHTML = state.subjects[state.form.subject].notes
    .map((n) => `<button type="button" class="chip${state.form.notes.has(n) ? ' on' : ''}" data-note="${esc(n)}">${esc(n)}</button>`)
    .join('');
}

$('#f-wrong').addEventListener('click', (e) => {
  const b = e.target.closest('.qbtn');
  if (!b) return;
  const q = Number(b.dataset.q);
  state.form.wrong.has(q) ? state.form.wrong.delete(q) : state.form.wrong.add(q);
  renderQGrid();
});

$('#f-notes').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  const n = b.dataset.note;
  state.form.notes.has(n) ? state.form.notes.delete(n) : state.form.notes.add(n);
  renderNoteChips();
});

document.querySelectorAll('#form-subject .seg-btn').forEach((b) => b.addEventListener('click', () => setFormSubject(b.dataset.subject, true)));

$('#f-date-unknown').addEventListener('change', (e) => {
  $('#f-date').disabled = e.target.checked;
  if (e.target.checked) $('#f-date').value = '';
});

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function openDialog(exam) {
  state.editing = exam || null;
  $('#dialog-title').textContent = exam ? '기록 수정' : '기록 추가';
  $('#exam-error').hidden = true;
  $('#f-name-custom').value = '';
  state.form.wrong = new Set(exam ? exam.wrong : []);
  state.form.notes = new Set(exam ? exam.notes : []);

  const unknown = exam ? !exam.examDate : false;
  $('#f-date-unknown').checked = unknown;
  $('#f-date').disabled = unknown;
  $('#f-date').value = exam ? exam.examDate || '' : todayStr();
  $('#f-date').max = todayStr();
  fillYearOptions(exam ? exam.schoolYear : defaultSchoolYear());
  $('#f-round').value = exam ? exam.round : '';
  $('#f-score').value = exam ? exam.score : '';

  setFormSubject(exam ? exam.subject : state.subject, false);
  fillNameOptions(state.form.subject, exam ? exam.examName : '');
  dialog.showModal();
}

function closeDialog() {
  dialog.close();
}

$('#add-btn').addEventListener('click', () => openDialog(null));
$('#dialog-close').addEventListener('click', closeDialog);
$('#dialog-cancel').addEventListener('click', closeDialog);

$('#exam-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('#exam-error');
  const unknown = $('#f-date-unknown').checked;
  const examDate = unknown ? null : $('#f-date').value;
  const examName = currentName();
  const scoreStr = $('#f-score').value.trim();

  const errors = [];
  if (!unknown && !examDate) errors.push('날짜를 선택하거나 "날짜 모름"을 체크해 주세요.');
  if (!examName) errors.push('모의고사 이름을 선택하거나 입력해 주세요.');
  if (scoreStr === '' || !/^\d+$/.test(scoreStr) || Number(scoreStr) > 100) errors.push('점수는 0~100 사이의 정수로 입력해 주세요.');
  if (errors.length) {
    errEl.textContent = errors.join('\n');
    errEl.hidden = false;
    return;
  }

  const body = {
    subject: state.form.subject,
    examDate,
    schoolYear: Number($('#f-year').value),
    examName,
    round: $('#f-round').value.trim(),
    score: Number(scoreStr),
    wrong: [...state.form.wrong],
    notes: [...state.form.notes],
  };

  const btn = $('#exam-submit');
  btn.disabled = true;
  try {
    if (state.editing) await api(`/api/exams/${state.editing.id}`, { method: 'PUT', body });
    else await api('/api/exams', { method: 'POST', body });
    closeDialog();
    toast(state.editing ? '수정했습니다.' : '기록을 추가했습니다.');
    // 저장한 과목 탭으로 이동
    if (body.subject !== state.subject) document.querySelector(`#subject-tabs .seg-btn[data-subject="${body.subject}"]`).click();
    else await loadExams();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

// ---------- 시작 ----------
(async function init() {
  try {
    const { subjects } = await api('/api/config');
    state.subjects = subjects;
    const { user } = await api('/api/me');
    if (user) await enterApp(user);
    else showAuth();
  } catch (err) {
    showAuth();
  }
})();

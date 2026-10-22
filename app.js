/* Conciliador Mercado Livre — app (Fase 1: login, importação, histórico, base) */
(function () {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const CFG = window.CONFIG || {};
  const NOMES = { vendas: 'Vendas ML', liberacoes: 'Liberações MP', extrato: 'Extrato MP' };
  const PARSER = { vendas: 'parseVendas', liberacoes: 'parseLiberacoes', extrato: 'parseExtrato' };

  const brl = (n) => (n ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const int = (n) => (n ?? 0).toLocaleString('pt-BR');
  const dataBR = (iso) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '—');
  const mesBR = (iso) => {
    if (!iso) return '(sem data)';
    const [y, m] = iso.split('-');
    return ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'][+m - 1] + '/' + y;
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const tick = () => new Promise((r) => setTimeout(r, 30));
  const mostrar = (id) => $$('.tela').forEach((t) => { t.hidden = t.id !== id; });

  // ------------------------------------------------------------ boot
  if (!CFG.SUPABASE_URL || CFG.SUPABASE_URL.includes('SEU-PROJETO') || !window.supabase) {
    mostrar('tela-config');
    return;
  }
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
  let usuario = null;

  sb.auth.onAuthStateChange((_ev, sessao) => {
    usuario = sessao?.user || null;
    if (usuario) { $('#usuario-email').textContent = usuario.email; mostrar('tela-app'); }
    else mostrar('tela-login');
  });

  // ------------------------------------------------------------ login
  $('#form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#login-msg'); msg.className = 'msg'; msg.textContent = 'Entrando…';
    const { error } = await sb.auth.signInWithPassword({ email: $('#login-email').value.trim(), password: $('#login-senha').value });
    if (error) { msg.className = 'msg erro'; msg.textContent = 'E-mail ou senha inválidos.'; }
    else msg.textContent = '';
  });
  $('#btn-esqueci').addEventListener('click', async () => {
    const email = $('#login-email').value.trim(); const msg = $('#login-msg');
    if (!email) { msg.className = 'msg erro'; msg.textContent = 'Digite seu e-mail acima primeiro.'; return; }
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.href.split('#')[0] });
    msg.className = error ? 'msg erro' : 'msg ok';
    msg.textContent = error ? error.message : 'Enviamos um link de redefinição para o seu e-mail.';
  });
  $('#btn-sair').addEventListener('click', () => sb.auth.signOut());

  // ------------------------------------------------------------ abas
  $$('.aba').forEach((b) => b.addEventListener('click', () => {
    $$('.aba').forEach((x) => x.classList.toggle('ativa', x === b));
    $$('.painel').forEach((p) => { p.hidden = p.id !== 'aba-' + b.dataset.aba; });
    if (b.dataset.aba === 'historico') carregarHistorico();
    if (b.dataset.aba === 'base') carregarBase();
  }));

  // ------------------------------------------------------------ importar
  const fila = []; // { arquivo, buf, fonte, resultado, el, estado }
  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('sobre'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('sobre'); }));
  drop.addEventListener('drop', (e) => adicionar([...e.dataTransfer.files]));
  $('#arquivos').addEventListener('change', (e) => { adicionar([...e.target.files]); e.target.value = ''; });
  $('#btn-limpar').addEventListener('click', () => {
    fila.filter((f) => f.estado !== 'gravando').forEach((f) => f.el.remove());
    fila.splice(0, fila.length, ...fila.filter((f) => f.estado === 'gravando'));
    atualizarAcoes();
  });
  $('#btn-gravar-todos').addEventListener('click', async () => {
    for (const f of fila) if (f.estado === 'pronto') await gravar(f);
  });

  function atualizarAcoes() {
    $('#acoes-fila').hidden = fila.length === 0;
    $('#btn-gravar-todos').disabled = !fila.some((f) => f.estado === 'pronto');
  }

  async function adicionar(arquivos) {
    for (const arquivo of arquivos) {
      const el = $('#tpl-item').content.firstElementChild.cloneNode(true);
      const f = { arquivo, el, estado: 'lendo', fonte: null, resultado: null };
      fila.push(f);
      $('#fila').prepend(el);
      $('.item-nome', el).textContent = arquivo.name;
      $('.item-sub', el).textContent = (arquivo.size / 1024 / 1024).toFixed(1) + ' MB';
      status(f, 'Lendo arquivo…');
      $('.item-remover', el).addEventListener('click', () => {
        if (f.estado === 'gravando') return;
        el.remove(); fila.splice(fila.indexOf(f), 1); atualizarAcoes();
      });
      $('.item-gravar', el).addEventListener('click', () => gravar(f));
      $('.item-fonte', el).addEventListener('change', (e) => ler(f, e.target.value));
      atualizarAcoes();
      await tick();
      try {
        f.buf = new Uint8Array(await arquivo.arrayBuffer());
        const fonte = Parsers.detectarFonte(f.buf, arquivo.name);
        if (!fonte) throw new Error('Não reconheci o tipo do arquivo. Escolha a fonte no seletor ao lado.');
        await ler(f, fonte);
      } catch (err) {
        f.estado = 'erro'; status(f, err.message, 'erro'); atualizarAcoes();
      }
    }
  }

  async function ler(f, fonte) {
    f.fonte = fonte; f.estado = 'lendo';
    const el = f.el;
    el.className = 'item ' + fonte;
    $('.item-fonte', el).value = fonte;
    $('.item-gravar', el).disabled = true;
    status(f, 'Lendo e conferindo linhas…');
    await tick();
    try {
      const r = Parsers[PARSER[fonte]](f.buf, f.arquivo.name);
      f.resultado = r;
      const blocos = [['Período', `${dataBR(r.periodo.inicio)} a ${dataBR(r.periodo.fim)}`]];
      for (const [k, v] of Object.entries(r.resumo)) {
        const moeda = /receita|líquido|entradas|saídas/i.test(k);
        blocos.push([k, moeda ? brl(v) : int(v)]);
      }
      $('.item-resumo', el).innerHTML = blocos.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
      $('.item-avisos', el).innerHTML = r.avisos.map((a) => `<li>${esc(a)}</li>`).join('');
      $('.item-sub', el).textContent = `${NOMES[fonte]} · ${int(r.registros.length)} linhas · ${(f.arquivo.size / 1024 / 1024).toFixed(1)} MB`;
      if (!r.registros.length) throw new Error('Nenhuma linha válida encontrada.');
      f.estado = 'pronto';
      status(f, 'Pronto para gravar.');
      $('.item-gravar', el).disabled = false;
    } catch (err) {
      f.estado = 'erro'; status(f, err.message, 'erro');
    }
    atualizarAcoes();
  }

  function status(f, texto, cls = '') {
    const s = $('.item-status', f.el); s.className = 'item-status ' + cls; s.textContent = texto;
  }

  async function gravar(f) {
    if (f.estado !== 'pronto') return;
    const el = f.el; const r = f.resultado;
    f.estado = 'gravando'; atualizarAcoes();
    $('.item-gravar', el).disabled = true; $('.item-fonte', el).disabled = true;
    const barra = $('.barra', el); const fill = $('.barra-fill', el); barra.hidden = false; fill.style.width = '0%';
    status(f, 'Registrando importação…');

    let impId = null;
    const tot = { lidas: 0, novas: 0, alteradas: 0, sem_alteracao: 0 };
    try {
      const { data: imp, error: e1 } = await sb.from('importacoes').insert({
        fonte: f.fonte, arquivo: f.arquivo.name, usuario_email: usuario?.email || null,
        periodo_inicio: r.periodo.inicio, periodo_fim: r.periodo.fim,
        linhas_lidas: r.registros.length, avisos: r.avisos,
      }).select('id').single();
      if (e1) throw e1;
      impId = imp.id;

      const lote = CFG.TAMANHO_LOTE || 400;
      for (let i = 0; i < r.registros.length; i += lote) {
        const pedaco = r.registros.slice(i, i + lote);
        let tentativa = 0; let res;
        while (true) {
          res = await sb.rpc('importar_lote', { p_fonte: f.fonte, p_importacao_id: impId, p_linhas: pedaco });
          if (!res.error || ++tentativa >= 3) break;
          await new Promise((ok) => setTimeout(ok, 1000 * tentativa));
        }
        if (res.error) throw res.error;
        for (const k of Object.keys(tot)) tot[k] += res.data[k] || 0;
        const feito = Math.min(i + lote, r.registros.length);
        fill.style.width = (100 * feito / r.registros.length).toFixed(1) + '%';
        status(f, `Gravando… ${int(feito)} de ${int(r.registros.length)}`);
      }

      await sb.from('importacoes').update({
        status: 'concluida', finalizado_em: new Date().toISOString(),
        novas: tot.novas, alteradas: tot.alteradas, sem_alteracao: tot.sem_alteracao,
      }).eq('id', impId);

      f.estado = 'gravado';
      status(f, `✓ Gravado: ${int(tot.novas)} novas · ${int(tot.alteradas)} atualizadas · ${int(tot.sem_alteracao)} sem alteração`, 'ok');
    } catch (err) {
      const msg = err.message || String(err);
      if (impId) {
        await sb.from('importacoes').update({
          status: 'erro', finalizado_em: new Date().toISOString(), mensagem: msg,
          novas: tot.novas, alteradas: tot.alteradas, sem_alteracao: tot.sem_alteracao,
        }).eq('id', impId);
      }
      f.estado = 'pronto';
      $('.item-gravar', el).disabled = false; $('.item-gravar', el).textContent = 'Tentar de novo';
      status(f, `Erro: ${msg}. O que já foi gravado fica; ao tentar de novo, nada duplica.`, 'erro');
    }
    $('.item-fonte', el).disabled = false;
    atualizarAcoes();
  }

  // ------------------------------------------------------------ histórico
  async function carregarHistorico() {
    const t = $('#tab-historico');
    t.innerHTML = '<tr><td class="vazio">Carregando…</td></tr>';
    const { data, error } = await sb.from('importacoes').select('*').order('id', { ascending: false }).limit(100);
    if (error) { t.innerHTML = `<tr><td class="vazio">${esc(error.message)}</td></tr>`; return; }
    if (!data.length) { t.innerHTML = '<tr><td class="vazio">Nenhuma importação ainda.</td></tr>'; return; }
    t.innerHTML = `<thead><tr><th>#</th><th>Quando</th><th>Fonte</th><th>Arquivo</th><th>Período</th>
      <th class="n">Lidas</th><th class="n">Novas</th><th class="n">Atualizadas</th><th class="n">Iguais</th><th>Status</th><th>Usuário</th></tr></thead><tbody>` +
      data.map((i) => `<tr>
        <td class="mono">${i.id}</td>
        <td>${new Date(i.criado_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</td>
        <td><span class="chip ${i.fonte}">${NOMES[i.fonte]}</span></td>
        <td title="${esc(i.arquivo)}">${esc(i.arquivo.length > 36 ? i.arquivo.slice(0, 34) + '…' : i.arquivo)}</td>
        <td>${dataBR(i.periodo_inicio)} – ${dataBR(i.periodo_fim)}</td>
        <td class="n">${int(i.linhas_lidas)}</td><td class="n">${int(i.novas)}</td>
        <td class="n">${int(i.alteradas)}</td><td class="n">${int(i.sem_alteracao)}</td>
        <td><span class="tag ${i.status}" title="${esc(i.mensagem || '')}">${i.status}</span></td>
        <td>${esc(i.usuario_email || '')}</td></tr>`).join('') + '</tbody>';
  }

  // ------------------------------------------------------------ base
  async function carregarBase() {
    const t = $('#tab-base');
    t.innerHTML = '<tr><td class="vazio">Carregando…</td></tr>';
    const [{ data, error }, st] = await Promise.all([
      sb.from('resumo_base').select('*'),
      sb.from('status_nao_mapeados').select('*'),
    ]);
    if (error) { t.innerHTML = `<tr><td class="vazio">${esc(error.message)}</td></tr>`; return; }

    const fontes = ['vendas', 'liberacoes', 'extrato'];
    const meses = [...new Set(data.map((d) => d.mes))].sort((a, b) => (a || '9999').localeCompare(b || '9999'));
    const idx = {}; data.forEach((d) => { idx[d.fonte + '|' + d.mes] = d; });
    const tot = {}; fontes.forEach((f) => { tot[f] = { linhas: 0, valor: 0 }; });
    data.forEach((d) => { d.linhas = Number(d.linhas); d.valor = Number(d.valor || 0); tot[d.fonte].linhas += d.linhas; tot[d.fonte].valor += d.valor; });

    const rot = { vendas: ['Vendas', 'Receita de produtos'], liberacoes: ['Operações', 'Líquido de vendas (liberações − estornos)'], extrato: ['Lançamentos no extrato', 'Movimento líquido'] };
    $('#kpis').innerHTML = fontes.map((f) => `<div class="kpi ${f}"><span>${NOMES[f]} · ${rot[f][0]}</span><b>${int(tot[f].linhas)}</b><span>${rot[f][1]}: ${brl(tot[f].valor)}</span></div>`).join('');

    if (!data.length) { t.innerHTML = '<tr><td class="vazio">Base vazia. Importe os arquivos na aba Importar.</td></tr>'; }
    else {
      t.innerHTML = `<thead><tr><th>Mês</th>${fontes.map((f) => `<th class="n">${NOMES[f]} · linhas</th><th class="n">${NOMES[f]} · valor</th>`).join('')}</tr></thead><tbody>` +
        meses.map((m) => `<tr><td>${mesBR(m)}</td>${fontes.map((f) => {
          const d = idx[f + '|' + m];
          return `<td class="n">${d ? int(d.linhas) : '—'}</td><td class="n">${d ? brl(Number(d.valor)) : '—'}</td>`;
        }).join('')}</tr>`).join('') +
        `</tbody><tfoot><tr><td>Total</td>${fontes.map((f) => `<td class="n">${int(tot[f].linhas)}</td><td class="n">${brl(tot[f].valor)}</td>`).join('')}</tr></tfoot>`;
    }

    const box = $('#box-status');
    const sn = st.data || [];
    box.hidden = !sn.length;
    $('#tab-status').innerHTML = '<thead><tr><th>Status</th><th class="n">Vendas</th></tr></thead><tbody>' +
      sn.map((s) => `<tr><td>${esc(s.status)}</td><td class="n">${int(s.vendas)}</td></tr>`).join('') + '</tbody>';
  }
})();

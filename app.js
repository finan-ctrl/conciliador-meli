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
    if (usuario) {
      const primeiraVez = $('#tela-app').hidden;
      $('#usuario-email').textContent = usuario.email; mostrar('tela-app');
      if (primeiraVez) abrirAba('painel');
    }
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
  function abrirAba(nome) {
    $$('.aba').forEach((x) => x.classList.toggle('ativa', x.dataset.aba === nome));
    $$('.painel').forEach((p) => { p.hidden = p.id !== 'aba-' + nome; });
    if (nome === 'painel') carregarPainel();
    if (nome === 'divergencias') carregarDivergencias();
    if (nome === 'analise') carregarAnalise();
    if (nome === 'historico') carregarHistorico();
    if (nome === 'base') carregarBase();
  }
  $$('.aba').forEach((b) => b.addEventListener('click', () => abrirAba(b.dataset.aba)));

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
    let algum = false;
    for (const f of fila) if (f.estado === 'pronto') { algum = (await gravar(f, false)) || algum; }
    if (algum) await rodarConciliacao($('#msg-conc'));
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
      $('.item-gravar', el).addEventListener('click', async () => { if (await gravar(f, false)) rodarConciliacao($('#msg-conc')); });
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
    if (f.estado !== 'pronto') return false;
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
      $('.item-fonte', el).disabled = false; atualizarAcoes();
      return true;
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
    return false;
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
  // ================================================================ FASE 2
  const SIT = {
    a_menor: 'Recebido a menor', sem_repasse: 'Sem repasse', a_maior: 'Recebido a maior',
    status_novo: 'Status novo', em_andamento: 'Em andamento', aguardando: 'Aguardando liberação',
    contestado: 'Contestado no ML', resolvido: 'Resolvido', conciliado: 'Conciliado',
  };
  const SIT_PADRAO = ['a_menor', 'sem_repasse', 'a_maior', 'status_novo'];
  const sit = (s, desat) => `<span class="sit ${s}">${esc(SIT[s] || s)}</span>${desat ? ' <span class="sit desatualizada" title="O valor mudou depois da revisão">revisão desatualizada</span>' : ''}`;
  const brlCor = (n) => {
    const v = Number(n || 0);
    if (Math.abs(v) < 0.005) return brl(0);
    return `<span class="${v < 0 ? 'neg' : 'pos'}">${brl(v)}</span>`;
  };
  const pct = (a, b) => (b ? (100 * a / b).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%' : '—');

  // ---------------------------------------------------------- conciliação
  async function rodarConciliacao(alvoMsg) {
    if (alvoMsg) { alvoMsg.className = 'msg'; alvoMsg.textContent = 'Atualizando conciliação…'; }
    const { data, error } = await sb.rpc('reconciliar');
    if (error) {
      if (alvoMsg) { alvoMsg.className = 'msg erro'; alvoMsg.textContent = 'Erro na conciliação: ' + error.message; }
      return null;
    }
    const div = (data.a_menor || 0) + (data.sem_repasse || 0) + (data.status_novo || 0);
    if (alvoMsg) {
      alvoMsg.className = 'msg ok';
      alvoMsg.textContent = `✓ Conciliação atualizada: ${int(data.conciliado)} conciliadas · ${int(div)} divergentes · ${int(data.a_maior)} a maior · ${int(data.aguardando)} aguardando liberação.`;
    }
    atualizarBadge();
    return data;
  }
  $('#btn-reconciliar').addEventListener('click', async () => {
    const b = $('#btn-reconciliar'); b.disabled = true;
    await rodarConciliacao($('#info-conc'));
    b.disabled = false;
    carregarPainel(true);
  });

  async function atualizarBadge() {
    const { count } = await sb.from('vw_conciliacao').select('numero_venda', { count: 'exact', head: true })
      .in('situacao_final', ['a_menor', 'sem_repasse', 'status_novo']);
    const b = $('#badge-div'); b.hidden = !count; b.textContent = count || '';
  }

  // ---------------------------------------------------------- painel
  async function carregarPainel(manterInfo) {
    const tv = $('#tab-mes-venda'); const tr = $('#tab-mes-receb');
    tv.innerHTML = tr.innerHTML = '<tr><td class="vazio">Carregando…</td></tr>';
    const [pv, pr, ex] = await Promise.all([
      sb.from('painel_mes_venda').select('*').order('mes_venda'),
      sb.from('painel_mes_recebimento').select('*').order('mes_liberacao'),
      sb.from('conciliacao_execucoes').select('*').order('id', { ascending: false }).limit(1),
    ]);
    if (pv.error) { tv.innerHTML = `<tr><td class="vazio">${esc(pv.error.message)}</td></tr>`; return; }
    atualizarBadge();

    const ult = ex.data && ex.data[0];
    if (!manterInfo) {
      $('#info-conc').className = 'msg';
      $('#info-conc').textContent = ult
        ? `Última conciliação: ${new Date(ult.executado_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })} · liberações importadas até ${dataBR(ult.resumo && ult.resumo.data_referencia)}`
        : 'A conciliação ainda não foi executada. Clique em "Reprocessar conciliação".';
    }

    const L = (pv.data || []).map((r) => { const o = {}; for (const [k, v] of Object.entries(r)) o[k] = k === 'mes_venda' ? v : Number(v || 0); return o; });
    if (!L.length) {
      $('#kpis-painel').innerHTML = '';
      tv.innerHTML = '<tr><td class="vazio">Sem dados. Importe os arquivos e rode a conciliação.</td></tr>';
    } else {
      const T = {}; L.forEach((r) => Object.entries(r).forEach(([k, v]) => { if (k !== 'mes_venda') T[k] = (T[k] || 0) + v; }));
      const ativas = T.vendas - T.canceladas;
      $('#kpis-painel').innerHTML = `
        <div class="kpi"><span>Vendas no período</span><b>${int(T.vendas)}</b><small>${int(T.canceladas)} canceladas/devolvidas · GMV ${brl(T.gmv)}</small></div>
        <div class="kpi"><span>Tarifas do ML</span><b>${pct(-T.tarifas, T.gmv)}</b><small>${brl(-T.tarifas)} sobre o GMV</small></div>
        <div class="kpi ok"><span>Conciliadas</span><b>${pct(T.conciliadas, T.vendas)}</b><small>${int(T.conciliadas)} de ${int(T.vendas)} vendas</small></div>
        <div class="kpi err"><span>Divergências em aberto</span><b>${int(T.divergentes)}</b><small>${brl(-T.valor_divergente)} a receber</small></div>
        <div class="kpi info"><span>Aguardando liberação</span><b>${int(T.aguardando)}</b><small>${brl(T.valor_aguardando)} previstos</small></div>
        <div class="kpi warn"><span>Recebido a maior</span><b>${int(T.a_maior)}</b><small>${brl(T.valor_a_maior)}</small></div>`;
      const lk = (n, mes, sits) => (n ? `<a class="num" data-mes="${mes || ''}" data-sit="${sits}">${int(n)}</a>` : '<span class="nota">0</span>');
      const linha = (r, total) => {
        const mes = total ? '' : r.mes_venda;
        return `<tr${total ? ' class="tot"' : ''}>
          <td>${total ? 'Total' : mesBR(r.mes_venda)}</td>
          <td class="n">${int(r.vendas)}</td><td class="n">${int(r.canceladas)}</td>
          <td class="n">${brl(r.gmv)}</td><td class="n">${pct(-r.tarifas, r.gmv)}</td>
          <td class="n">${brl(r.esperado)}</td><td class="n">${brl(r.recebido)}</td>
          <td class="n">${lk(r.conciliadas, mes, 'conciliado')}</td>
          <td class="n">${lk(r.aguardando, mes, 'aguardando')}</td>
          <td class="n">${lk(r.divergentes, mes, 'a_menor,sem_repasse,status_novo')}</td>
          <td class="n">${brlCor(r.valor_divergente)}</td>
          <td class="n">${lk(r.a_maior, mes, 'a_maior')}</td>
          <td class="n">${lk(r.em_andamento, mes, 'em_andamento')}</td>
          <td class="n">${lk(r.contestadas + r.resolvidas, mes, 'contestado,resolvido')}</td>
        </tr>`;
      };
      tv.innerHTML = `<thead><tr><th>Mês da venda</th><th class="n">Vendas</th><th class="n">Canceladas</th><th class="n">GMV</th><th class="n">Tarifas</th>
        <th class="n">Líquido esperado</th><th class="n">Recebido</th><th class="n">Conciliadas</th><th class="n">Aguardando</th>
        <th class="n">Divergentes</th><th class="n">Valor divergente</th><th class="n">A maior</th><th class="n">Em andamento</th><th class="n">Revisadas</th></tr></thead>
        <tbody>${L.map((r) => linha(r)).join('')}</tbody><tfoot>${linha(T, true)}</tfoot>`;
      $$('a.num', tv).forEach((a) => a.addEventListener('click', () => {
        filtro.sits = new Set(a.dataset.sit.split(',')); filtro.mes = a.dataset.mes; filtro.pag = 0;
        abrirAba('divergencias');
      }));
    }

    const R = (pr.data || []).map((r) => { const o = {}; for (const [k, v] of Object.entries(r)) o[k] = k === 'mes_liberacao' ? v : Number(v || 0); return o; });
    if (!R.length) { tr.innerHTML = '<tr><td class="vazio">Sem liberações importadas.</td></tr>'; return; }
    const TR = {}; R.forEach((r) => Object.entries(r).forEach(([k, v]) => { if (k !== 'mes_liberacao') TR[k] = (TR[k] || 0) + v; }));
    const lr = (r, total) => `<tr><td>${total ? 'Total' : mesBR(r.mes_liberacao)}</td>
      <td class="n">${brl(r.liberado)}</td><td class="n">${brl(r.estornos)}</td><td class="n"><b>${brl(r.liquido_vendas)}</b></td>
      <td class="n">${brl(r.cashback)}</td><td class="n">${brl(r.faturas)}</td><td class="n">${brl(r.saques)}</td>
      <td class="n" title="${int(r.qtd_sem_venda)} operações">${brl(r.sem_venda)}</td><td class="n">${int(r.qtd_sem_extrato)}</td></tr>`;
    tr.innerHTML = `<thead><tr><th>Mês da liberação</th><th class="n">Liberado</th><th class="n">Estornos</th><th class="n">Líquido de vendas</th>
      <th class="n">Cashback</th><th class="n">Faturas ML</th><th class="n">Saques</th><th class="n" title="Liberações cuja venda não está na base (ex.: vendas do mês ainda não importadas)">Sem venda na base</th>
      <th class="n" title="Operações sem lançamento correspondente no extrato importado">Sem extrato</th></tr></thead>
      <tbody>${R.map((r) => lr(r)).join('')}</tbody><tfoot>${lr(TR, true)}</tfoot>`;
  }

  // ---------------------------------------------------------- divergências
  const filtro = { sits: new Set(SIT_PADRAO), mes: '', busca: '', comissao: false, pag: 0 };
  const POR_PAG = 50;
  let mesesCarregados = false;

  async function prepararFiltros() {
    // contagem por situação (respeitando mês)
    let q = sb.from('vw_conciliacao').select('situacao_final');
    if (filtro.mes) q = q.eq('mes_venda', filtro.mes);
    const cont = {};
    for (let de = 0; ; de += 1000) {
      const { data, error } = await q.range(de, de + 999);
      if (error || !data) break;
      data.forEach((r) => { cont[r.situacao_final] = (cont[r.situacao_final] || 0) + 1; });
      if (data.length < 1000) break;
    }
    $('#chips-situacao').innerHTML = Object.keys(SIT).map((k) =>
      `<button class="chip-f ${filtro.sits.has(k) ? 'on' : ''}" data-sit="${k}">${SIT[k]} <b>${int(cont[k] || 0)}</b></button>`).join('');
    $$('#chips-situacao .chip-f').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.sit;
      if (filtro.sits.has(k)) filtro.sits.delete(k); else filtro.sits.add(k);
      filtro.pag = 0; carregarDivergencias();
    }));
    if (!mesesCarregados) {
      const { data } = await sb.from('painel_mes_venda').select('mes_venda').order('mes_venda', { ascending: false });
      $('#f-mes').innerHTML = '<option value="">Todos os meses</option>' +
        (data || []).filter((r) => r.mes_venda).map((r) => `<option value="${r.mes_venda}">${mesBR(r.mes_venda)}</option>`).join('');
      mesesCarregados = true;
    }
    $('#f-mes').value = filtro.mes;
    $('#f-busca').value = filtro.busca;
    $('#f-comissao').checked = filtro.comissao;
  }

  function consulta(colunas, opcoes) {
    let q = sb.from('vw_conciliacao').select(colunas, opcoes);
    if (filtro.sits.size) q = q.in('situacao_final', [...filtro.sits]);
    if (filtro.mes) q = q.eq('mes_venda', filtro.mes);
    if (filtro.comissao) q = q.eq('comissao_acima', true);
    const b = filtro.busca.replace(/[^\p{L}\p{N} \-]/gu, '').trim();
    if (b) q = q.or(`numero_venda.ilike.*${b}*,sku.ilike.*${b}*,titulo.ilike.*${b}*`);
    return q.order('abs_diferenca', { ascending: false }).order('data_venda', { ascending: false });
  }

  async function carregarDivergencias() {
    const t = $('#tab-div');
    t.innerHTML = '<tr><td class="vazio">Carregando…</td></tr>';
    await prepararFiltros();
    const de = filtro.pag * POR_PAG;
    const { data, error, count } = await consulta('numero_venda,data_venda,status,titulo,sku,esperado,repasse,diferenca,situacao_final,revisao_desatualizada,comissao_acima,comissao_excedente,motivo', { count: 'exact' })
      .range(de, de + POR_PAG - 1);
    if (error) { t.innerHTML = `<tr><td class="vazio">${esc(error.message)}</td></tr>`; return; }
    if (!data.length) { t.innerHTML = '<tr><td class="vazio">Nada encontrado com esses filtros. 🎉</td></tr>'; }
    else {
      t.innerHTML = `<thead><tr><th>Nº da venda</th><th>Data</th><th>Status ML</th><th>Produto</th>
        <th class="n">Esperado</th><th class="n">Recebido</th><th class="n">Diferença</th><th>Situação</th></tr></thead><tbody>` +
        data.map((r) => `<tr data-venda="${esc(r.numero_venda)}">
          <td class="mono">${esc(r.numero_venda)}</td>
          <td>${dataBR(r.data_venda)}</td>
          <td class="trunc" title="${esc(r.status)}">${esc(r.status)}</td>
          <td class="trunc" title="${esc(r.titulo)}">${esc(r.titulo)}</td>
          <td class="n">${brl(Number(r.esperado))}</td><td class="n">${brl(Number(r.repasse))}</td>
          <td class="n">${brlCor(r.diferenca)}</td>
          <td>${sit(r.situacao_final, r.revisao_desatualizada)}${r.comissao_acima ? ' <span class="sit a_maior" title="Excedente ' + brl(Number(r.comissao_excedente)) + '">comissão ↑</span>' : ''}</td>
        </tr>`).join('') + '</tbody>';
      $$('tbody tr', t).forEach((tr) => tr.addEventListener('click', () => abrirDetalhe(tr.dataset.venda)));
    }
    const total = count || 0;
    $('#pag-info').textContent = total ? `${int(de + 1)}–${int(Math.min(de + POR_PAG, total))} de ${int(total)}` : '';
    $('#pag-ant').disabled = filtro.pag === 0;
    $('#pag-prox').disabled = de + POR_PAG >= total;
  }
  $('#pag-ant').addEventListener('click', () => { filtro.pag--; carregarDivergencias(); });
  $('#pag-prox').addEventListener('click', () => { filtro.pag++; carregarDivergencias(); });
  $('#f-mes').addEventListener('change', (e) => { filtro.mes = e.target.value; filtro.pag = 0; carregarDivergencias(); });
  $('#f-comissao').addEventListener('change', (e) => { filtro.comissao = e.target.checked; filtro.pag = 0; carregarDivergencias(); });
  let tBusca;
  $('#f-busca').addEventListener('input', (e) => {
    clearTimeout(tBusca);
    tBusca = setTimeout(() => { filtro.busca = e.target.value; filtro.pag = 0; carregarDivergencias(); }, 400);
  });

  $('#btn-exportar').addEventListener('click', async () => {
    const b = $('#btn-exportar'); b.disabled = true; b.textContent = 'Exportando…';
    const cols = ['numero_venda', 'data_venda', 'mes_venda', 'status', 'acao', 'titulo', 'sku', 'tipo_anuncio', 'receita', 'tarifa_venda', 'tarifa_envio',
      'esperado', 'liberado', 'estornado', 'repasse', 'diferenca', 'situacao_final', 'motivo', 'comissao_pct', 'comissao_tabela_pct', 'comissao_excedente',
      'ultima_liberacao', 'decisao', 'justificativa', 'revisado_por', 'revisado_em'];
    const linhas = [];
    for (let de = 0; ; de += 1000) {
      const { data, error } = await consulta(cols.join(',')).range(de, de + 999);
      if (error) { alertaInline(error.message); break; }
      linhas.push(...data);
      if (data.length < 1000) break;
    }
    const fmt = (v) => {
      if (v === null || v === undefined) return '';
      if (typeof v === 'number') return String(v).replace('.', ',');
      const s = String(v);
      return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const csv = '﻿' + cols.join(';') + '\n' + linhas.map((r) => cols.map((c) => fmt(r[c])).join(';')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `divergencias_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click(); URL.revokeObjectURL(a.href);
    b.disabled = false; b.textContent = 'Exportar CSV';
  });
  function alertaInline(m) { $('#pag-info').textContent = 'Erro: ' + m; }

  // ---------------------------------------------------------- detalhe
  const fecharDetalhe = () => { $('#drawer').hidden = true; $('#drawer-fundo').hidden = true; };
  $('#dw-fechar').addEventListener('click', fecharDetalhe);
  $('#drawer-fundo').addEventListener('click', fecharDetalhe);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') fecharDetalhe(); });

  async function abrirDetalhe(numero) {
    $('#drawer').hidden = false; $('#drawer-fundo').hidden = false;
    $('#dw-titulo').textContent = numero;
    const corpo = $('#dw-corpo'); corpo.innerHTML = '<div class="vazio">Carregando…</div>';

    const [c, v, libs, revs, filhos, tars] = await Promise.all([
      sb.from('vw_conciliacao').select('*').eq('numero_venda', numero).maybeSingle(),
      sb.from('vendas_ml').select('numero_venda,tipo_linha,data_venda,status,descricao_status,titulo,variacao,sku,tipo_anuncio,unidades,preco_unitario,receita_produtos,receita_acrescimo,taxa_parcelamento,tarifa_venda,receita_envio,tarifa_envio,custo_diferenca_peso,descontos_bonus,cancelamentos_reembolsos,total,forma_entrega,data_entrega,reclamacao_aberta,em_mediacao,resultado_devolucao,motivo_resultado').eq('numero_venda', numero).maybeSingle(),
      sb.from('liberacoes_mp').select('data_liberacao,tipo_operacao,numero_liberacao,numero_operacao,valor_bruto,tarifas_total,valor_liquido,detalhes_tarifas,status_operacao').eq('venda_vinculada', numero).order('data_liberacao'),
      sb.from('revisoes').select('*').eq('numero_venda', numero).order('id', { ascending: false }),
      sb.from('vendas_ml').select('numero_venda,titulo,sku').eq('numero_pacote', numero).neq('numero_venda', numero),
      sb.from('liberacao_tarifas').select('categoria,nome,valor').eq('venda_vinculada', numero),
    ]);
    if (c.error || !c.data) { corpo.innerHTML = `<div class="vazio">${esc((c.error && c.error.message) || 'Venda não encontrada na conciliação.')}</div>`; return; }
    const C = c.data; const V = v.data || {}; const LIB = libs.data || [];
    const numsVenda = [numero, ...((filhos.data || []).map((x) => x.numero_venda))];
    const [hist, ext] = await Promise.all([
      sb.from('vendas_ml_status_hist').select('*').in('numero_venda', numsVenda).order('id'),
      LIB.length ? sb.from('extrato_mp').select('reference_id,data,valor').in('reference_id', [...new Set(LIB.map((l) => l.numero_liberacao).filter(Boolean))]) : Promise.resolve({ data: [] }),
    ]);
    const noExtrato = new Set((ext.data || []).map((e) => e.reference_id));
    const n = (x) => Number(x || 0);
    const linhaConta = (rot, val) => (n(val) ? `<span>${rot}</span><span>${brl(n(val))}</span>` : '');

    corpo.innerHTML = `
      <div class="bloco">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center">
          <div>${sit(C.situacao_final, C.revisao_desatualizada)} ${C.comissao_acima ? '<span class="sit a_maior">comissão acima da tabela</span>' : ''}</div>
          <div style="font-size:18px;font-weight:700">${brlCor(C.diferenca)}</div>
        </div>
        ${C.motivo ? `<p style="margin:8px 0 0">${esc(C.motivo)}</p>` : ''}
      </div>

      <div class="bloco">
        <h3>Venda</h3>
        <div class="grade">
          <div><span>Data</span><b>${V.data_venda ? new Date(V.data_venda).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—'}</b></div>
          <div><span>Status ML</span><b>${esc(V.status || '—')}</b></div>
          <div><span>Detalhe do status</span><b>${esc(V.descricao_status || '—')}</b></div>
          <div><span>Ação</span><b>${esc(C.acao || 'sem classificação')}</b></div>
          <div style="grid-column:1/-1"><span>Produto</span><b>${esc(V.titulo || C.titulo || '—')}${V.variacao ? ' · ' + esc(V.variacao) : ''}</b></div>
          <div><span>SKU</span><b>${esc(V.sku || '—')}</b></div>
          <div><span>Anúncio</span><b>${esc(V.tipo_anuncio || '—')}</b></div>
          <div><span>Unidades</span><b>${int(V.unidades)}</b></div>
          <div><span>Comissão cobrada × tabela</span><b>${C.comissao_pct != null ? n(C.comissao_pct).toLocaleString('pt-BR') + '%' : '—'} × ${C.comissao_tabela_pct != null ? n(C.comissao_tabela_pct).toLocaleString('pt-BR') + '%' : '—'}</b></div>
          ${V.reclamacao_aberta === 'Sim' || V.em_mediacao === 'Sim' ? `<div><span>Reclamação / mediação</span><b>${esc(V.reclamacao_aberta || '—')} / ${esc(V.em_mediacao || '—')}</b></div>` : ''}
          ${V.resultado_devolucao ? `<div><span>Resultado devolução</span><b>${esc(V.resultado_devolucao)}${V.motivo_resultado ? ' — ' + esc(V.motivo_resultado) : ''}</b></div>` : ''}
        </div>
        ${(filhos.data || []).length ? `<p class="nota" style="margin-top:10px">Pacote com ${filhos.data.length} vendas: ${filhos.data.map((f) => `<span class="mono">${esc(f.numero_venda)}</span> (${esc(f.sku || '')})`).join(', ')}</p>` : ''}
      </div>

      <div class="bloco">
        <h3>Esperado × recebido</h3>
        <div class="conta">
          ${linhaConta('Receita de produtos', V.receita_produtos)}
          ${linhaConta('Acréscimo pago pelo comprador', V.receita_acrescimo)}
          ${linhaConta('Taxa de parcelamento', V.taxa_parcelamento)}
          ${linhaConta('Tarifa de venda e impostos', V.tarifa_venda)}
          ${linhaConta('Receita por envio', V.receita_envio)}
          ${linhaConta('Tarifas de envio', V.tarifa_envio)}
          ${linhaConta('Diferença de peso/medidas', V.custo_diferenca_peso)}
          ${linhaConta('Descontos e bônus', V.descontos_bonus)}
          ${linhaConta('Cancelamentos e reembolsos', V.cancelamentos_reembolsos)}
          <span class="tot">Esperado (Total do ML)</span><span class="tot">${brl(n(C.esperado))}</span>
          <span>Recebido (liberações − estornos)</span><span>${brl(n(C.repasse))}</span>
          <span class="tot">Diferença</span><span class="tot">${brlCor(C.diferenca)}</span>
        </div>
      </div>

      <div class="bloco">
        <h3>Liberações no Mercado Pago</h3>
        ${LIB.length ? `<div class="tabela-wrap"><table class="tabela mini"><thead><tr><th>Data</th><th>Tipo</th><th>Nº liberação</th><th class="n">Bruto</th><th class="n">Tarifas</th><th class="n">Líquido</th><th>Extrato</th></tr></thead><tbody>
          ${LIB.map((l) => `<tr title="${esc((l.detalhes_tarifas || '').replace(/\n/g, ' '))}"><td>${dataBR(l.data_liberacao)}</td><td>${esc(l.tipo_operacao)}</td><td class="mono">${esc(l.numero_liberacao)}</td>
            <td class="n">${brl(n(l.valor_bruto))}</td><td class="n">${brl(n(l.tarifas_total))}</td><td class="n">${n(l.valor_liquido) < 0 ? `<span class="neg">${brl(n(l.valor_liquido))}</span>` : brl(n(l.valor_liquido))}</td>
            <td>${noExtrato.has(l.numero_liberacao) ? '✓' : '<span class="nota">não encontrado</span>'}</td></tr>`).join('')}
          </tbody></table></div><p class="nota" style="margin-top:6px">Passe o mouse numa linha para ver o detalhe das tarifas.</p>` : '<p class="nota">Nenhuma liberação vinculada a esta venda.</p>'}
      </div>

      ${(() => {
        const T = {}; (tars.data || []).forEach((x) => { const k = x.categoria + '|' + x.nome; T[k] = (T[k] || 0) + n(x.valor); });
        const ks = Object.keys(T).filter((k) => Math.abs(T[k]) >= 0.005).sort();
        if (!ks.length) return '';
        const tot = ks.reduce((a, k) => a + T[k], 0);
        return `<div class="bloco"><h3>Tarifas cobradas nas liberações</h3><div class="conta">
          ${ks.map((k) => { const [cat, nome] = k.split('|'); return `<span>${esc(nome)} <span class="nota">· ${esc(cat)}</span></span><span>${brl(T[k])}</span>`; }).join('')}
          <span class="tot">Total de tarifas</span><span class="tot">${brl(tot)}</span>
          <span>% sobre a receita</span><span>${n(V.receita_produtos) ? pctN(tot, n(V.receita_produtos)) : '—'}</span></div>
          <p class="nota" style="margin-top:6px">Valores negativos = tarifa devolvida (cancelamento/estorno).</p></div>`;
      })()}

      <div class="bloco">
        <h3>Histórico de status no ML</h3>
        ${(hist.data || []).length ? `<ul class="lista-rev">${hist.data.map((h) => `<li><b>${esc(h.status_novo || '—')}</b>${h.status_anterior ? ` <span class="nota">(antes: ${esc(h.status_anterior)})</span>` : ''}<div class="meta">${new Date(h.alterado_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}${numsVenda.length > 1 ? ' · venda ' + esc(h.numero_venda) : ''}</div></li>`).join('')}</ul>` : '<p class="nota">Sem histórico.</p>'}
      </div>

      <div class="bloco">
        <h3>Revisão</h3>
        ${C.situacao_final === 'conciliado' && !(revs.data || []).length ? '<p class="nota">Venda conciliada — nada a revisar.</p>' : `
        <form id="form-rev" class="form-rev">
          <div class="opcoes">
            <label class="check"><input type="radio" name="decisao" value="resolvido" required> Resolvido</label>
            <label class="check"><input type="radio" name="decisao" value="contestado"> Contestado no ML</label>
            <label class="check"><input type="radio" name="decisao" value="reaberto"> Reabrir</label>
          </div>
          <textarea name="justificativa" required placeholder="Justificativa (ex.: nº do chamado no ML, explicação da diferença)"></textarea>
          <div><button class="btn primario" type="submit">Salvar revisão</button> <span id="rev-msg" class="msg"></span></div>
        </form>`}
        ${(revs.data || []).length ? `<ul class="lista-rev" style="margin-top:12px">${revs.data.map((r) => `<li><b>${esc(SIT[r.decisao] || (r.decisao === 'reaberto' ? 'Reaberto' : r.decisao))}</b> — ${esc(r.justificativa)}
          <div class="meta">${esc(r.usuario_email || '')} · ${new Date(r.criado_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })} · diferença na época ${brl(n(r.diferenca_na_revisao))}</div></li>`).join('')}</ul>` : ''}
      </div>`;

    const form = $('#form-rev');
    if (form) form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form); const msg = $('#rev-msg');
      const just = String(fd.get('justificativa') || '').trim();
      if (!just) { msg.className = 'msg erro'; msg.textContent = 'Escreva a justificativa.'; return; }
      msg.className = 'msg'; msg.textContent = 'Salvando…';
      const { error } = await sb.from('revisoes').insert({
        numero_venda: numero, decisao: fd.get('decisao'), justificativa: just,
        diferenca_na_revisao: n(C.diferenca), situacao_na_revisao: C.situacao, usuario_email: usuario?.email || null,
      });
      if (error) { msg.className = 'msg erro'; msg.textContent = error.message; return; }
      await abrirDetalhe(numero);
      if (!$('#aba-divergencias').hidden) carregarDivergencias();
      atualizarBadge();
    });
  }
  // ================================================================ ANÁLISE
  const an = { agrupar: 'mes', mes: '', tipo: '', busca: '', pag: 0 };
  const AN_POR_PAG = 50;
  const CAT_ORDEM = ['Comissão ML', 'Parcelamento', 'Custo Mercado Pago', 'Frete', 'Devolução', 'Outras', 'Não detalhado'];
  let anMesesOk = false;
  const pctN = (v, base) => (base ? (100 * v / base).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%' : '—');
  const pctTxt = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 }) + '%');
  const num0 = (r) => { const o = {}; for (const [k, v] of Object.entries(r)) o[k] = (typeof v === 'string' && k !== 'grupo' && k !== 'rotulo' && !isNaN(v) && v !== '') ? Number(v) : v; return o; };

  $$('#an-agrupar button').forEach((b) => b.addEventListener('click', () => { an.agrupar = b.dataset.v; an.pag = 0; carregarAnalise(); }));
  $('#an-mes').addEventListener('change', (e) => { an.mes = e.target.value; an.pag = 0; carregarAnalise(); });
  $('#an-tipo').addEventListener('change', (e) => { an.tipo = e.target.value; an.pag = 0; carregarAnalise(); });
  let tAn;
  $('#an-busca').addEventListener('input', (e) => { clearTimeout(tAn); tAn = setTimeout(() => { an.busca = e.target.value.trim(); an.pag = 0; carregarAnalise(); }, 400); });
  $('#an-limpar').addEventListener('click', () => { Object.assign(an, { mes: '', tipo: '', busca: '', pag: 0 }); carregarAnalise(); });
  $('#an-ant').addEventListener('click', () => { an.pag--; carregarAnalise(); });
  $('#an-prox').addEventListener('click', () => { an.pag++; carregarAnalise(); });

  const limpaBusca = (b) => (b || '').replace(/[^\p{L}\p{N} \-]/gu, '').trim();
  const rpcAnalise = (agrupar) => sb.rpc('analise', {
    p_agrupar: agrupar, p_mes: an.mes || null, p_tipo: an.tipo || null, p_busca: limpaBusca(an.busca) || null,
  });

  let anSeq = 0;
  async function carregarAnalise() {
    const seq = ++anSeq;
    $$('#an-agrupar button').forEach((b) => b.classList.toggle('on', b.dataset.v === an.agrupar));
    if (!anMesesOk) {
      const { data } = await sb.from('painel_mes_venda').select('mes_venda').order('mes_venda', { ascending: false });
      $('#an-mes').innerHTML = '<option value="">Todos os meses</option>' +
        (data || []).filter((r) => r.mes_venda).map((r) => `<option value="${r.mes_venda}">${mesBR(r.mes_venda)}</option>`).join('');
      anMesesOk = true;
    }
    $('#an-mes').value = an.mes; $('#an-tipo').value = an.tipo; $('#an-busca').value = an.busca;
    const t = $('#an-tab'); t.innerHTML = '<tr><td class="vazio">Carregando…</td></tr>';

    const agr = an.agrupar === 'venda' ? 'mes' : an.agrupar;
    const { data, error } = await rpcAnalise(agr);
    if (seq !== anSeq) return;
    if (error) { t.innerHTML = `<tr><td class="vazio">${esc(error.message)}</td></tr>`; return; }
    const L = (data || []).map(num0);

    // totais do recorte
    const T = { tarifas_mp: {} };
    L.forEach((r) => {
      for (const [k, v] of Object.entries(r)) if (typeof v === 'number') T[k] = (T[k] || 0) + v;
      for (const [c, v] of Object.entries(r.tarifas_mp || {})) T.tarifas_mp[c] = (T.tarifas_mp[c] || 0) + Number(v);
    });
    desenharChecks(T);
    desenharCascata(T);
    desenharTarifas(T);

    if (an.agrupar === 'venda') return carregarVendaAVenda(seq);
    $('#an-pag').hidden = true;
    const nomeG = { mes: 'Mês da venda', produto: 'Produto (SKU)', tipo: 'Tipo de anúncio' }[an.agrupar];
    $('#an-titulo-tab').textContent = `Detalhamento por ${nomeG.toLowerCase()}`;
    $('#an-dica').textContent = 'Clique numa linha para ver venda a venda.';
    if (!L.length) { t.innerHTML = '<tr><td class="vazio">Nada encontrado com esses filtros.</td></tr>'; return; }

    const linha = (r, total) => {
      const prob = (r.divergentes || 0) + (r.a_maior || 0) + (r.comissao_acima || 0);
      const confere = prob
        ? `<span class="ck no" title="${int(r.divergentes)} divergentes · ${int(r.a_maior)} a maior · ${int(r.comissao_acima)} comissão acima">⚠ ${int(prob)}</span>`
        : '<span class="ck ok">✓ OK</span>';
      const rot = total ? 'Total' : (an.agrupar === 'mes' ? mesBR(r.grupo + '-01') : r.rotulo);
      return `<tr${total ? ' class="tot"' : ` data-g="${esc(r.grupo)}"`}>
        <td class="trunc" title="${esc(rot)}">${esc(rot)}</td>
        <td class="n">${int(r.vendas)}<small class="sub2">${int(r.canceladas)} canc.</small></td>
        <td class="n">${brl(r.receita)}</td>
        <td class="n">${brl(r.comissao)}<small class="sub2">${pctN(-r.comissao, r.receita)} · tabela ${pctN(r.comissao_tabela, r.receita)}</small></td>
        <td class="n">${brl(r.frete)}<small class="sub2">${pctN(-r.frete, r.receita)}</small></td>
        <td class="n">${brl(r.outros)}</td><td class="n">${brl(r.custo_canceladas)}</td>
        <td class="n"><b>${brl(r.esperado)}</b></td><td class="n">${brl(r.recebido)}</td><td class="n">${brlCor(r.diferenca)}</td>
        <td class="n">${pctN(r.conciliadas, r.vendas)}</td><td>${confere}</td></tr>`;
    };
    t.innerHTML = `<thead><tr><th>${nomeG}</th><th class="n">Vendas</th><th class="n">Receita</th>
      <th class="n" title="Cobrado × o que a tabela prevê">Comissão ML</th>
      <th class="n">Frete</th><th class="n" title="Acréscimos, descontos, bônus, diferença de peso">Outros</th>
      <th class="n" title="Resultado das vendas canceladas/devolvidas (custos que ficaram)">Custo canceladas</th>
      <th class="n">Líquido esperado</th><th class="n">Recebido</th><th class="n">Diferença</th><th class="n">Conciliadas</th><th>Confere</th></tr></thead>
      <tbody>${L.map((r) => linha(r)).join('')}</tbody><tfoot>${linha(T, true)}</tfoot>`;
    $$('tbody tr[data-g]', t).forEach((tr) => tr.addEventListener('click', () => {
      const g = tr.dataset.g;
      if (an.agrupar === 'mes') an.mes = g + '-01';
      else if (an.agrupar === 'tipo') { if (g !== '(pacotes)') an.tipo = g; }
      else if (an.agrupar === 'produto') an.busca = g === '(pacotes)' ? 'Pacote' : g;
      an.agrupar = 'venda'; an.pag = 0; carregarAnalise();
    }));
  }

  function desenharChecks(T) {
    const pill = (ok, txt, nivel) => `<span class="check-pill ${ok ? 'ok' : nivel}"><span class="ic">${ok ? '✓' : '⚠'}</span>${txt}</span>`;
    const div = T.divergentes || 0; const maior = T.a_maior || 0;
    $('#an-checks').innerHTML = [
      pill(!div, div ? `${int(div)} venda(s) com repasse a menor ou sem repasse` : `Repasse confere em ${pctN(T.conciliadas, T.vendas)} das vendas`, 'erro'),
      pill(!maior, maior ? `${int(maior)} venda(s) recebidas a maior` : 'Nenhum repasse a maior', 'alerta'),
      pill(!T.comissao_acima, T.comissao_acima ? `${int(T.comissao_acima)} venda(s) com comissão acima da tabela` : 'Comissão dentro da tabela', 'erro'),
      pill(!T.com_lib_sem_extrato, T.com_lib_sem_extrato ? `${int(T.com_lib_sem_extrato)} venda(s) com liberação fora do extrato importado` : 'Liberações batem com o extrato', 'alerta'),
      T.aguardando ? `<span class="check-pill"><span class="ic">⏳</span>${int(T.aguardando)} aguardando liberação</span>` : '',
      T.em_andamento ? `<span class="check-pill"><span class="ic">↺</span>${int(T.em_andamento)} em devolução/reclamação</span>` : '',
    ].join('');
  }

  function barras(alvo, linhas, base) {
    const max = Math.max(base || 0, ...linhas.filter((l) => !l.sep).map((l) => Math.abs(l.v || 0))) || 1;
    alvo.innerHTML = linhas.map((l) => {
      if (l.sep) return '<div class="sep"></div>';
      const w = Math.min(100, 100 * Math.abs(l.v || 0) / max);
      return `<div class="rot ${l.cls || ''}">${esc(l.rot)}</div>
        <div class="trilho" title="${esc(l.rot)}: ${brl(l.v)}${base ? ' · ' + pctN(Math.abs(l.v || 0), base) + ' da receita' : ''}"><div class="barra-c ${l.pos ? 'pos' : ''}" style="width:${w.toFixed(1)}%"></div></div>
        <div class="val ${l.cls || ''}">${l.html || brl(l.v)}</div>
        <div class="pc">${base && !l.semPct ? pctN(Math.abs(l.v || 0), base) : ''}</div>`;
    }).join('');
  }

  function desenharCascata(T) {
    const rec = T.receita || 0;
    barras($('#an-cascata'), [
      { rot: 'Receita das vendas', v: rec, pos: true, cls: 'forte' },
      { rot: '− Comissão e taxas ML', v: T.comissao, cls: 'sub' },
      { rot: '− Frete', v: T.frete, cls: 'sub' },
      { rot: '± Outros (acréscimos, descontos, peso)', v: T.outros, cls: 'sub' },
      { rot: '− Custo das canceladas/devolvidas', v: T.custo_canceladas, cls: 'sub' },
      { sep: true },
      { rot: '= Líquido esperado', v: T.esperado, pos: true, cls: 'forte' },
      { rot: 'Recebido (repasse)', v: T.recebido, pos: true },
      { rot: 'Diferença', v: T.diferenca, html: brlCor(T.diferenca), semPct: true, cls: 'forte' },
      ...[['· aguardando liberação', T.dif_aguardando], ['· em devolução/reclamação', T.dif_em_andamento],
          ['· divergente (cobrar do ML)', T.dif_divergente], ['· recebido a maior', T.dif_a_maior], ['· já revisado', T.dif_revisada]]
        .filter(([, v]) => Math.abs(v || 0) >= 0.005)
        .map(([rot, v]) => ({ rot, v, html: brlCor(v), semPct: true, cls: 'sub' })),
    ], rec);
  }

  function desenharTarifas(T) {
    const cats = Object.keys(T.tarifas_mp).sort((a, b) => (CAT_ORDEM.indexOf(a) + 99 * (CAT_ORDEM.indexOf(a) < 0)) - (CAT_ORDEM.indexOf(b) + 99 * (CAT_ORDEM.indexOf(b) < 0)));
    if (!cats.length) { $('#an-tarifas').innerHTML = '<p class="nota">Sem tarifas nas liberações deste recorte.</p>'; return; }
    const tot = cats.reduce((s, c) => s + T.tarifas_mp[c], 0);
    barras($('#an-tarifas'), [
      ...cats.map((c) => ({ rot: c, v: T.tarifas_mp[c] })),
      { sep: true },
      { rot: 'Total de tarifas', v: tot, cls: 'forte' },
    ], T.receita || 0);
  }

  async function carregarVendaAVenda(seq) {
    const t = $('#an-tab');
    $('#an-titulo-tab').textContent = 'Venda a venda';
    $('#an-dica').textContent = 'Clique numa venda para ver o detalhe completo.';
    let q = sb.from('vw_conciliacao').select('numero_venda,data_venda,titulo,sku,status,acao,receita,tarifa_venda,tarifa_envio,esperado,repasse,diferenca,comissao_pct,comissao_tabela_pct,comissao_acima,lib_sem_extrato,qtd_operacoes,situacao_final', { count: 'exact' });
    if (an.mes) q = q.eq('mes_venda', an.mes);
    if (an.tipo) q = q.eq('tipo_anuncio', an.tipo);
    const b = limpaBusca(an.busca);
    if (b) q = q.or(`numero_venda.ilike.*${b}*,sku.ilike.*${b}*,titulo.ilike.*${b}*`);
    const de = an.pag * AN_POR_PAG;
    const { data, error, count } = await q.order('data_venda', { ascending: false }).range(de, de + AN_POR_PAG - 1);
    if (seq !== anSeq) return;
    if (error) { t.innerHTML = `<tr><td class="vazio">${esc(error.message)}</td></tr>`; return; }
    if (!data.length) { t.innerHTML = '<tr><td class="vazio">Nada encontrado com esses filtros.</td></tr>'; $('#an-pag').hidden = true; return; }
    const ck = (estado, titulo) => estado === null ? `<span class="ck na" title="${esc(titulo)}">—</span>`
      : `<span class="ck ${estado ? 'ok' : 'no'}" title="${esc(titulo)}">${estado ? '✓' : '✗'}</span>`;
    t.innerHTML = `<thead><tr><th>Nº da venda</th><th>Data</th><th>Produto</th><th class="n">Receita</th>
      <th class="n" title="Cobrado · tabela">Comissão ML</th><th class="n">Frete</th><th class="n">Outros</th>
      <th class="n">Esperado</th><th class="n">Recebido</th><th class="n">Diferença</th><th>Repasse</th><th>Comissão</th><th>Extrato</th><th>Situação</th></tr></thead><tbody>` +
      data.map((r0) => {
        const r = num0(r0);
        const outros = r.esperado - r.receita - r.tarifa_venda - r.tarifa_envio;
        const repOk = ['conciliado', 'resolvido'].includes(r.situacao_final) ? true : (['aguardando', 'em_andamento'].includes(r.situacao_final) ? null : false);
        const comOk = r.comissao_tabela_pct === null || r.comissao_pct === null ? null : !r.comissao_acima;
        const extOk = r.qtd_operacoes ? r.lib_sem_extrato === 0 : null;
        return `<tr data-venda="${esc(r.numero_venda)}">
          <td class="mono">${esc(r.numero_venda)}</td><td>${dataBR(r.data_venda)}</td>
          <td class="trunc" title="${esc(r.titulo)}">${esc(r.titulo)}<small class="sub2 esq">${esc(r.status)}</small></td>
          <td class="n">${brl(r.receita)}</td>
          <td class="n">${brl(r.tarifa_venda)}<small class="sub2">${pctTxt(r.comissao_pct)} · tabela ${pctTxt(r.comissao_tabela_pct)}</small></td>
          <td class="n">${brl(r.tarifa_envio)}</td><td class="n">${brl(outros)}</td>
          <td class="n"><b>${brl(r.esperado)}</b></td><td class="n">${brl(r.repasse)}</td><td class="n">${brlCor(r.diferenca)}</td>
          <td>${ck(repOk, repOk === null ? 'Ainda em aberto' : (repOk ? 'Repasse confere' : 'Repasse não confere'))}</td>
          <td>${ck(comOk, comOk === null ? 'Sem comparação (cancelada, devolução ou pacote)' : (comOk ? 'Dentro da tabela' : 'Acima da tabela'))}</td>
          <td>${ck(extOk, extOk === null ? 'Sem liberação' : (extOk ? 'Liberações no extrato' : `${r.lib_sem_extrato} liberação(ões) fora do extrato`))}</td>
          <td>${sit(r.situacao_final)}</td></tr>`;
      }).join('') + '</tbody>';
    $$('tbody tr', t).forEach((tr) => tr.addEventListener('click', () => abrirDetalhe(tr.dataset.venda)));
    const total = count || 0;
    $('#an-pag').hidden = false;
    $('#an-pag-info').textContent = `${int(de + 1)}–${int(Math.min(de + AN_POR_PAG, total))} de ${int(total)}`;
    $('#an-ant').disabled = an.pag === 0;
    $('#an-prox').disabled = de + AN_POR_PAG >= total;
  }
})();

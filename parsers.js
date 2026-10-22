/* =====================================================================
 * Conciliador Mercado Livre — leitura e normalização dos arquivos
 * Fontes: Vendas ML (.xlsx), Liberações MP (.xlsx/.csv), Extrato MP (.csv/.xlsx)
 * Funciona no navegador (XLSX global) e no Node (testes).
 * ===================================================================== */
(function (root) {
  'use strict';
  const XLSX = root.XLSX || (typeof require === 'function' ? require('xlsx') : null);

  // ------------------------------------------------------------------ util
  const MAC_ROMAN = 'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';
  const MAC_MAP = new Map([...MAC_ROMAN].map((c, i) => [c, 0x80 + i]));
  const utf8 = new TextDecoder('utf-8', { fatal: true });

  /** Corrige texto UTF-8 lido como Mac Roman ("D√©bito") ou Latin-1 ("DÃ©bito"). */
  function corrigeAcentos(s) {
    if (typeof s !== 'string' || !/[√Ã]/.test(s)) return s;
    const tenta = (map) => {
      const bytes = [];
      for (const ch of s) {
        const c = ch.charCodeAt(0);
        if (c < 0x80) bytes.push(c);
        else if (map && map.has(ch)) bytes.push(map.get(ch));
        else if (!map && c <= 0xff) bytes.push(c);
        else return null;
      }
      try { return utf8.decode(new Uint8Array(bytes)); } catch (e) { return null; }
    };
    return (s.includes('√') ? tenta(MAC_MAP) : tenta(null)) || s;
  }

  const semAcento = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');
  const normHeader = (s) => semAcento(s).toLowerCase().replace(/\s+/g, ' ').trim();

  function texto(v) {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    const s = corrigeAcentos(String(v)).trim();
    return s === '' ? null : s;
  }

  /** ID numérico como texto. Avisa se veio como número grande (perda de precisão no Excel). */
  function id(v, avisos, campo) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') {
      if (!Number.isSafeInteger(v) && avisos) avisos.add(`${campo}: IDs com mais de 15 dígitos vieram como número e podem ter perdido precisão. Exporte com a coluna como texto.`);
      return Number.isInteger(v) ? v.toFixed(0) : String(v);
    }
    const s = String(v).trim();
    return s === '' ? null : s;
  }

  /** Número em qualquer formato: 1234.5 | "1.234,56" | "-25,67" | "R$ 10,00" */
  function num(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    let s = String(v).replace(/R\$|\s/g, '').trim();
    if (s === '' || s === '-') return null;
    if (s.includes(',') && s.includes('.')) {
      s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    } else if (s.includes(',')) {
      s = s.replace(',', '.');
    }
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  function simNao(v) {
    const s = texto(v);
    if (!s) return null;
    const n = semAcento(s).toLowerCase();
    if (n === 'sim') return true;
    if (n === 'nao') return false;
    return null;
  }

  const pad = (n) => String(n).padStart(2, '0');
  const isoData = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

  /** Data: Date | serial Excel | "2026-05-10" | "04/06/2026" | "12-05-2026" */
  function data(v) {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date) {
      if (isNaN(v)) return null;
      // SheetJS cria Date em UTC à meia-noite; usamos os componentes UTC
      return isoData(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
    }
    if (typeof v === 'number') {
      const p = XLSX && XLSX.SSF ? XLSX.SSF.parse_date_code(v) : null;
      return p ? isoData(p.y, p.m, p.d) : null;
    }
    const s = String(v).trim();
    let m;
    if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return isoData(+m[1], +m[2], +m[3]);
    if ((m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/))) return isoData(+m[3], +m[2], +m[1]);
    return null;
  }

  const MESES = { janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7,
    agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12 };

  /** "30 de setembro de 2026 23:55 hs." -> "2026-09-30T23:55:00-03:00" */
  function dataVendaML(v) {
    if (v instanceof Date || typeof v === 'number') { const d = data(v); return d ? d + 'T00:00:00-03:00' : null; }
    const s = semAcento(String(v || '')).toLowerCase();
    const m = s.match(/(\d{1,2}) de ([a-z]+) de (\d{4})(?:\D+(\d{1,2}):(\d{2}))?/);
    if (!m || !MESES[m[2]]) return null;
    return `${isoData(+m[3], MESES[m[2]], +m[1])}T${pad(m[4] || 0)}:${pad(m[5] || 0)}:00-03:00`;
  }

  const primeiroDoMes = (iso) => (iso ? iso.slice(0, 7) + '-01' : null);

  /** Hash rápido (cyrb53) para saber se a linha mudou entre importações */
  function hash(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }
  const comHash = (o) => { o.linha_hash = hash(JSON.stringify(o)); return o; };

  // ---------------------------------------------------- leitura de arquivo
  function decodeTexto(buf) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
    catch (e) { return new TextDecoder('windows-1252').decode(buf); }
  }

  function parseCSV(txt) {
    txt = txt.replace(/^﻿/, '');
    const primeira = txt.split(/\r?\n/).find((l) => l.trim()) || '';
    const sep = [';', '\t', ','].sort((a, b) => primeira.split(b).length - primeira.split(a).length)[0];
    const linhas = []; let linha = []; let campo = ''; let aspas = false;
    for (let i = 0; i < txt.length; i++) {
      const c = txt[i];
      if (aspas) {
        if (c === '"') { if (txt[i + 1] === '"') { campo += '"'; i++; } else aspas = false; }
        else campo += c;
      } else if (c === '"') aspas = true;
      else if (c === sep) { linha.push(campo); campo = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && txt[i + 1] === '\n') i++;
        linha.push(campo); linhas.push(linha); linha = []; campo = '';
      } else campo += c;
    }
    if (campo !== '' || linha.length) { linha.push(campo); linhas.push(linha); }
    return linhas;
  }

  /** Lê .xlsx/.xls/.csv e devolve a matriz de linhas da aba que contém o cabeçalho esperado. */
  function lerMatriz(buf, nomeArquivo, cabecalhoChave) {
    const ext = (nomeArquivo.split('.').pop() || '').toLowerCase();
    const alvo = normHeader(cabecalhoChave);
    if (ext === 'csv' || ext === 'txt') return parseCSV(decodeTexto(buf));
    const wb = XLSX.read(buf, { type: 'array', cellDates: true, dense: false });
    for (const nome of wb.SheetNames) {
      const m = XLSX.utils.sheet_to_json(wb.Sheets[nome], { header: 1, raw: true, defval: null, blankrows: false });
      if (m.slice(0, 20).some((r) => (r || []).some((c) => c !== null && normHeader(corrigeAcentos(String(c))) === alvo))) return m;
    }
    throw new Error(`Não encontrei a coluna "${cabecalhoChave}" em nenhuma aba do arquivo.`);
  }

  /** Acha a linha de cabeçalho e devolve objetos por linha.
   *  Cabeçalhos repetidos ganham sufixo: "Estado", "Estado__2"... */
  function tabela(matriz, cabecalhoChave) {
    const alvo = normHeader(cabecalhoChave);
    const iHead = matriz.findIndex((r, i) => i < 30 && (r || []).some((c) => c !== null && normHeader(corrigeAcentos(String(c))) === alvo));
    if (iHead < 0) throw new Error(`Cabeçalho "${cabecalhoChave}" não encontrado nas primeiras linhas.`);
    const vistos = {};
    const heads = matriz[iHead].map((h) => {
      if (h === null || h === undefined || String(h).trim() === '') return null;
      const n = normHeader(corrigeAcentos(String(h)));
      vistos[n] = (vistos[n] || 0) + 1;
      return vistos[n] > 1 ? `${n}__${vistos[n]}` : n;
    });
    const linhas = [];
    for (let i = iHead + 1; i < matriz.length; i++) {
      const r = matriz[i] || [];
      if (!r.some((c) => c !== null && String(c).trim() !== '')) continue;
      const o = {};
      heads.forEach((h, j) => { if (h) o[h] = r[j] === undefined ? null : r[j]; });
      linhas.push(o);
    }
    return { cabecalhos: heads.filter(Boolean), linhas };
  }

  const get = (o, nome) => o[normHeader(nome)];

  function exigir(cabecalhos, obrigatorios) {
    const faltam = obrigatorios.filter((c) => !cabecalhos.includes(normHeader(c)));
    if (faltam.length) throw new Error('Colunas obrigatórias não encontradas: ' + faltam.join(', '));
  }

  function periodo(datas) {
    const v = datas.filter(Boolean).sort();
    return { inicio: v[0] || null, fim: v[v.length - 1] || null };
  }

  /** Chave única com sufixo #n quando a mesma chave aparece mais de uma vez no arquivo */
  function chaveUnica() {
    const cont = new Map();
    return (base) => {
      const n = (cont.get(base) || 0) + 1;
      cont.set(base, n);
      return n === 1 ? base : `${base}#${n}`;
    };
  }

  // ------------------------------------------------------- 1. Vendas ML
  const PII_VENDAS = ['Dados pessoais ou da empresa', 'Tipo e número do documento', 'Endereço', 'Endereço__2',
    'Comprador', 'CPF', 'Inscrição estadual', 'CEP', 'URL de acompanhamento', 'URL de acompanhamento__2']
    .map((c) => (c.includes('__') ? normHeader(c.split('__')[0]) + '__' + c.split('__')[1] : normHeader(c)));

  function parseVendas(buf, nomeArquivo) {
    const avisos = new Set();
    const { cabecalhos, linhas } = tabela(lerMatriz(buf, nomeArquivo, 'N.º de venda'), 'N.º de venda');
    exigir(cabecalhos, ['N.º de venda', 'Data de venda', 'Estado', 'Receita por produtos (BRL)', 'Tarifa de venda e impostos (BRL)', 'Total (BRL)']);

    const porVenda = new Map();
    let pacoteAtual = null; let filhosRestantes = 0; let semData = 0;

    for (const r of linhas) {
      const numero = id(get(r, 'N.º de venda'), avisos, 'N.º de venda');
      if (!numero) continue;
      const status = texto(get(r, 'Estado'));
      const mPac = status && semAcento(status).match(/^Pacote de (\d+) produtos?/i);

      let tipo = 'venda'; let numeroPacote = null;
      if (mPac) {
        tipo = 'pacote'; numeroPacote = numero; pacoteAtual = numero; filhosRestantes = +mPac[1];
      } else if (filhosRestantes > 0) {
        tipo = 'item_pacote'; numeroPacote = pacoteAtual; filhosRestantes--;
      }

      const dataVenda = dataVendaML(get(r, 'Data de venda'));
      if (!dataVenda) semData++;

      const dados = {};
      for (const [k, v] of Object.entries(r)) {
        if (PII_VENDAS.includes(k)) continue;
        const t = typeof v === 'number' ? v : texto(v);
        if (t !== null) dados[k] = t;
      }

      const o = {
        numero_venda: numero,
        tipo_linha: tipo,
        numero_pacote: numeroPacote,
        data_venda: dataVenda,
        mes_venda: primeiroDoMes(dataVenda),
        status,
        descricao_status: texto(get(r, 'Descrição do status')),
        pacote_diversos: simNao(get(r, 'Pacote de diversos produtos')),
        kit: simNao(get(r, 'Pertence a um kit')),
        unidades: num(get(r, 'Unidades')),
        receita_produtos: num(get(r, 'Receita por produtos (BRL)')),
        receita_acrescimo: num(get(r, 'Receita por acréscimo no preço (pago pelo comprador)')),
        taxa_parcelamento: num(get(r, 'Taxa de parcelamento equivalente ao acréscimo')),
        tarifa_venda: num(get(r, 'Tarifa de venda e impostos (BRL)')),
        receita_envio: num(get(r, 'Receita por envio (BRL)')),
        tarifa_envio: num(get(r, 'Tarifas de envio (BRL)')),
        custo_envio_declarado: num(get(r, 'Custo de envio com base nas medidas e peso declarados')),
        custo_diferenca_peso: num(get(r, 'Custo por diferenças nas medidas e no peso do pacote')),
        descontos_bonus: num(get(r, 'Descontos e bônus')),
        cancelamentos_reembolsos: num(get(r, 'Cancelamentos e reembolsos (BRL)')),
        total: num(get(r, 'Total (BRL)')),
        mes_faturamento_tarifas: texto(get(r, 'Mês de faturamento das suas tarifas')),
        venda_publicidade: simNao(get(r, 'Venda por publicidade')),
        sku: id(get(r, 'SKU')),
        anuncio_id: texto(get(r, '# de anúncio')),
        loja_oficial: texto(get(r, 'Loja oficial')),
        titulo: texto(get(r, 'Título do anúncio')),
        variacao: texto(get(r, 'Variação')),
        preco_unitario: num(get(r, 'Preço unitário de venda do anúncio (BRL)')),
        tipo_anuncio: texto(get(r, 'Tipo de anúncio')),
        nfe_anexo: texto(get(r, 'NF-e em anexo')),
        cidade: texto(get(r, 'Cidade')),
        uf: texto(r['estado__2']),
        forma_entrega: texto(get(r, 'Forma de entrega')),
        data_a_caminho: texto(get(r, 'Data a caminho')),
        data_entrega: texto(get(r, 'Data de entrega')),
        transportador: texto(get(r, 'Transportador')),
        rastreamento: texto(get(r, 'Número de rastreamento')),
        dev_forma_entrega: texto(r['forma de entrega__2']),
        dev_data_a_caminho: texto(r['data a caminho__2']),
        dev_data_entrega: texto(r['data de entrega__2']),
        dev_transportador: texto(r['transportador__2']),
        dev_rastreamento: texto(r['numero de rastreamento__2']),
        dev_unidades: num(r['unidades__2']),
        revisado_ml: texto(get(r, 'Revisado pelo Mercado Livre')),
        data_revisao: texto(get(r, 'Data de revisão')),
        dinheiro_liberado: texto(get(r, 'Dinheiro liberado')),
        resultado_devolucao: texto(get(r, 'Resultado')),
        destino_devolucao: texto(get(r, 'Destino')),
        motivo_resultado: texto(get(r, 'Motivo do resultado')),
        reclamacao_aberta: texto(get(r, 'Reclamação aberta')),
        reclamacao_encerrada: texto(get(r, 'Reclamação encerrada')),
        em_mediacao: texto(get(r, 'Em mediação')),
        dados,
      };
      if (porVenda.has(numero)) avisos.add('Vendas repetidas no arquivo: mantida a última ocorrência.');
      porVenda.set(numero, comHash(o));
    }
    if (semData) avisos.add(`${semData} venda(s) sem data de venda reconhecida.`);
    const registros = [...porVenda.values()];
    const p = periodo(registros.map((x) => x.data_venda && x.data_venda.slice(0, 10)));
    const pacotes = registros.filter((x) => x.tipo_linha === 'pacote').length;
    return {
      fonte: 'vendas', registros, avisos: [...avisos],
      periodo: p,
      resumo: {
        'Vendas': registros.filter((x) => x.tipo_linha !== 'pacote').length,
        'Pacotes': pacotes,
        'Receita (sem duplicar pacotes)': registros.filter((x) => x.tipo_linha !== 'item_pacote')
          .reduce((s, x) => s + (x.receita_produtos || 0), 0),
      },
    };
  }

  // ------------------------------------------------- 2. Liberações MP
  function parseLiberacoes(buf, nomeArquivo) {
    const avisos = new Set();
    const { cabecalhos, linhas } = tabela(lerMatriz(buf, nomeArquivo, 'Número da liberação'), 'Número da liberação');
    exigir(cabecalhos, ['Data da liberação', 'Número da liberação', 'Tipo de operação', 'Número da operação', 'Valor líquido após tarifas']);
    const unica = chaveUnica();
    const registros = [];
    for (const r of linhas) {
      const dataLib = data(get(r, 'Data da liberação'));
      const numLib = id(get(r, 'Número da liberação'), avisos, 'Número da liberação');
      const tipo = texto(get(r, 'Tipo de operação'));
      if (!dataLib && !numLib && !tipo) continue;
      const numOp = id(get(r, 'Número da operação'), avisos, 'Número da operação');
      const itemId = texto(get(r, 'ID do Item'));
      const liquido = num(get(r, 'Valor líquido após tarifas'));
      const o = {
        chave: null,
        data_liberacao: dataLib,
        mes_liberacao: primeiroDoMes(dataLib),
        numero_liberacao: numLib,
        tipo_operacao: tipo,
        data_operacao: data(get(r, 'Data da operação')),
        numero_operacao: numOp,
        status_operacao: texto(get(r, 'Status da operação')),
        item_id: itemId,
        item: texto(get(r, 'Item')),
        sku: id(get(r, 'SKU')),
        categoria: texto(get(r, 'Categoria')),
        tipo_anuncio: texto(get(r, 'Tipo de anúncio')),
        quantidade: num(get(r, 'Quantidade de itens')),
        valor_item: num(get(r, 'Valor do item')),
        desconto_ml: num(get(r, 'Desconto do Mercado Livre | Rebate (-)')),
        desconto_vendedor: num(get(r, 'Desconto do vendedor para comprador (-)')),
        detalhes_descontos: texto(get(r, 'Detalhes de descontos')),
        envio_pago_comprador: num(get(r, 'Envio pago pelo comprador (+)')),
        taxa_parcelamento_comprador: num(get(r, 'Taxa de parcelamento paga pelo comprador (+)')),
        valor_bruto: num(get(r, 'Valor bruto (=)')),
        beneficios_ml: num(get(r, 'Benefícios do Mercado Livre ao comprador')),
        reclamacoes_devolucoes: num(get(r, 'Reclamações e devoluções')),
        tarifas_total: num(get(r, 'Valor total de tarifas (desconto já aplicado)')),
        tarifas_pos_pagas: num(get(r, 'Valor total de tarifas pós-pagas')),
        valor_liquido: liquido,
        detalhes_tarifas: texto(get(r, 'Detalhes de tarifas')),
        numero_envio: id(get(r, 'Número do envio'), avisos, 'Número do envio'),
        numero_pacote: id(get(r, 'Número do pacote'), avisos, 'Número do pacote'),
        metodo_envio: texto(get(r, 'Método de envio')),
        envio_valor_bruto: num(get(r, 'Valor bruto do envio')),
        envio_desconto: num(get(r, 'Desconto sobre o envio')),
        envio_pago_vendedor: num(get(r, 'Envio pago pelo vendedor')),
        periodo_faturamento: texto(get(r, 'Período de faturamento')),
        data_fechamento: data(get(r, 'Data do fechamento')),
        numero_nfe: id(get(r, 'Número da NF-e')),
        detalhes_nf: texto(get(r, 'Detalhes da nota fiscal')),
        detalhes_pagamento: texto(get(r, 'Detalhes de pagamento')),
      };
      o.chave = unica([numLib, tipo, numOp, itemId, dataLib, liquido].map((x) => x ?? '').join('|'));
      registros.push(comHash(o));
    }
    const tipos = {};
    registros.forEach((x) => { tipos[x.tipo_operacao || '(vazio)'] = (tipos[x.tipo_operacao || '(vazio)'] || 0) + 1; });
    return {
      fonte: 'liberacoes', registros, avisos: [...avisos],
      periodo: periodo(registros.map((x) => x.data_liberacao)),
      resumo: Object.assign({ 'Operações': registros.length,
        'Líquido de vendas (liberações − estornos)': registros
          .filter((x) => !['Saque', 'Pagamento de faturas'].includes(x.tipo_operacao))
          .reduce((s, x) => s + (x.valor_liquido || 0), 0) }, tipos),
    };
  }

  // ---------------------------------------------------- 3. Extrato MP
  function parseExtrato(buf, nomeArquivo) {
    const avisos = new Set();
    const { cabecalhos, linhas } = tabela(lerMatriz(buf, nomeArquivo, 'RELEASE_DATE'), 'RELEASE_DATE');
    exigir(cabecalhos, ['RELEASE_DATE', 'TRANSACTION_TYPE', 'REFERENCE_ID', 'TRANSACTION_NET_AMOUNT']);
    const unica = chaveUnica();
    const registros = [];
    let corrigidos = 0;
    for (const r of linhas) {
      const d = data(get(r, 'RELEASE_DATE'));
      if (!d) continue;
      const bruto = get(r, 'TRANSACTION_TYPE');
      const tipo = texto(bruto);
      if (bruto && tipo !== String(bruto).trim()) corrigidos++;
      const ref = id(get(r, 'REFERENCE_ID'), avisos, 'REFERENCE_ID');
      const valor = num(get(r, 'TRANSACTION_NET_AMOUNT'));
      const saldo = num(get(r, 'PARTIAL_BALANCE'));
      const o = {
        chave: unica([d, tipo, ref, valor, saldo].map((x) => x ?? '').join('|')),
        data: d, mes: primeiroDoMes(d), tipo_transacao: tipo, reference_id: ref,
        valor, saldo_parcial: saldo,
      };
      registros.push(comHash(o));
    }
    if (corrigidos) avisos.add(`Acentuação corrigida em ${corrigidos} descrições (arquivo veio com codificação trocada).`);
    return {
      fonte: 'extrato', registros, avisos: [...avisos],
      periodo: periodo(registros.map((x) => x.data)),
      resumo: { 'Lançamentos': registros.length,
        'Entradas': registros.reduce((s, x) => s + Math.max(x.valor || 0, 0), 0),
        'Saídas': registros.reduce((s, x) => s + Math.min(x.valor || 0, 0), 0) },
    };
  }

  /** Tenta descobrir a fonte pelo conteúdo do arquivo */
  function detectarFonte(buf, nomeArquivo) {
    const testes = [['vendas', 'N.º de venda'], ['liberacoes', 'Número da liberação'], ['extrato', 'RELEASE_DATE']];
    for (const [fonte, col] of testes) {
      try {
        const m = lerMatriz(buf, nomeArquivo, col);
        const alvo = normHeader(col);
        if (m.slice(0, 30).some((r) => (r || []).some((c) => c !== null && normHeader(corrigeAcentos(String(c))) === alvo))) return fonte;
      } catch (e) { /* tenta a próxima */ }
    }
    return null;
  }

  const api = { parseVendas, parseLiberacoes, parseExtrato, detectarFonte,
    _util: { corrigeAcentos, num, data, dataVendaML, parseCSV, hash } };
  root.Parsers = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

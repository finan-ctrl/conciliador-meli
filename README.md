# Conciliador Mercado Livre

Base de dados no Supabase + site com login para importar e gravar os relatórios:

| Fonte | Arquivo | Chave (o que evita duplicar) |
|---|---|---|
| Vendas ML | relatório de Vendas do Mercado Livre (.xlsx) | N.º de venda |
| Liberações MP | relatório de liberações do Mercado Pago (.xlsx/.csv) | nº liberação + tipo + nº operação + item + data + valor |
| Extrato MP | extrato da conta Mercado Pago (.csv/.xlsx) | data + tipo + reference_id + valor + saldo |

Reimportar é seguro: linha nova entra, linha que mudou é atualizada (ex.: venda "Entregue" que virou devolução — fica no histórico de status), linha igual é ignorada.

## Estrutura

```
index.html    telas (login, Painel, Análise, Divergências, Importar, Histórico, Base)
style.css
config.js     URL e chave do Supabase
parsers.js    leitura e normalização dos 3 arquivos
app.js        telas, gravação e conciliação
schema.sql    banco completo (rodar no SQL Editor; pode rodar de novo sem perder dados)
```
Todos os arquivos ficam soltos na raiz do repositório.

## Passo a passo

### 1. Supabase (≈10 min)
1. Crie um projeto em supabase.com (região São Paulo). Guarde a senha do banco.
2. **SQL Editor → New query** → cole todo o `supabase/schema.sql` → **Run**.
3. **Authentication → Sign In / Providers**: desligue *Allow new users to sign up* (só entra quem você cadastrar).
4. **Authentication → Users → Add user**: crie seu usuário com e-mail e senha (marque *Auto confirm*).
5. **Authentication → URL Configuration → Site URL**: coloque o endereço do site (passo 2), para o link de "Esqueci minha senha" voltar para ele.
6. **Project Settings → API**: copie *Project URL* e *anon public key*.

### 2. Site
1. Preencha `js/config.js` com a URL e a anon key.
2. Suba a pasta para um repositório no GitHub → **Settings → Pages → Deploy from branch (main, /root)**.
3. Abra o endereço do Pages e entre com o usuário criado.

> A anon key pode ficar no código: sem login ninguém lê nem grava nada (RLS do schema).

### 3. Carga inicial
Na aba **Importar**, arraste os 3 arquivos do pacote `carga-inicial-meli.zip` (fica fora do repositório — não suba planilhas para o GitHub) e clique **Gravar todos**.
Resultado esperado: 5.197 vendas, 6.524 operações de liberação, 6.968 lançamentos de extrato.
Confira na aba **Base**.

### 4. Rotina
Exporte os relatórios do período (pode sobrepor datas com a importação anterior) e importe. O sistema só grava o que é novo ou mudou.

## O que a importação já trata
- Cabeçalho em qualquer linha e colunas fora de ordem (procura pelo nome).
- Colunas repetidas do relatório de vendas (Estado do pedido × Estado/UF, entrega × devolução).
- Data "30 de setembro de 2026 23:55 hs." e números em formato brasileiro.
- Acentuação quebrada do extrato ("D√©bito" → "Débito").
- Pacotes: a linha "Pacote de N produtos" vira `tipo_linha = pacote` e as N vendas seguintes ficam ligadas a ele (`numero_pacote`), sem somar receita em dobro.
- Dados pessoais do comprador (nome, CPF, endereço) não são gravados.
- Aviso quando um ID longo vem como número no Excel (perda de precisão).

## Tabelas
- `vendas_ml`, `vendas_ml_status_hist` (toda mudança de status)
- `liberacoes_mp`, `extrato_mp`
- `importacoes` (log: quem, quando, arquivo, novas/atualizadas/iguais)
- `status_map` (status do ML → Conciliar / NOP / Avaliar; editável no Table Editor)
- Visões `resumo_base` e `status_nao_mapeados`

## Conciliação (fase 2)
Roda sozinha depois de cada importação (ou no botão **Reprocessar conciliação** do Painel).

- **Esperado** = coluna *Total (BRL)* do relatório de vendas (já desconta tarifas, frete, cancelamentos e reembolsos).
- **Recebido** = soma das liberações − estornos vinculados à venda (pelo nº da operação; se não achar, pelo nº do pacote).
- Pacote "Pacote de N produtos" é conciliado pela linha do pacote (as vendas filhas repetem os valores).
- Situações: Conciliado · Aguardando liberação · Recebido a menor · Sem repasse · Recebido a maior · Em andamento (devolução/reclamação aberta) · Status novo.
- Comissão cobrada × `comissao_tabela` (não vale para devoluções, cuja tarifa inclui o frete de retorno).
- Revisão manual (Resolvido / Contestado no ML / Reabrir) com justificativa; se o valor mudar depois, a revisão aparece como desatualizada.
- Ajustes em `parametros` (tolerância R$, dias de espera da liberação) e `comissao_tabela` pelo Table Editor.

## Análise
Venda → tarifas → repasse, por mês, produto, tipo de anúncio ou venda a venda.
- Cascata: receita − comissão e taxas ML − frete ± outros − custo das canceladas = líquido esperado × recebido; a diferença é aberta em aguardando / em devolução / divergente / a maior.
- Tarifas das liberações destrinchadas por tipo (Comissão ML, Parcelamento, Custo Mercado Pago, Frete, Devolução), lidas de "Detalhes de tarifas".
- Checagens: repasse confere, comissão × tabela, liberação presente no extrato.

## Próximas fases
- **Fase 3:** visão de caixa (liberado × sacado × saldo no extrato), conferência das liberações contra o extrato, fluxo de pedido de acesso com aprovação.

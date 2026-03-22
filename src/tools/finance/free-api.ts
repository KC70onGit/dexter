/**
 * Free Data Provider — Drop-in replacement for financialdatasets.ai API
 *
 * Routes each endpoint to the correct free source:
 *   - Stock prices, financials, key ratios, estimates, earnings → Yahoo Finance (yahoo-finance2)
 *   - Insider trades, SEC filings, segmented revenue → SEC EDGAR REST API (data.sec.gov)
 *   - News → Finnhub free tier (or fallback to Yahoo)
 *
 * FIX-042b: Zero cost, no API keys required for most endpoints.
 */

import YahooFinance from 'yahoo-finance2';
const yahooFinance = new YahooFinance();
import { readCache, writeCache, describeRequest } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';

export interface ApiResponse {
  data: Record<string, unknown>;
  url: string;
}

/** Re-export stripFieldsDeep unchanged — it's a utility, not data-source-specific */
export function stripFieldsDeep(value: unknown, fields: readonly string[]): unknown {
  const fieldsToStrip = new Set(fields);
  function walk(node: unknown): unknown {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const record = node as Record<string, unknown>;
    const cleaned: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record)) {
      if (fieldsToStrip.has(key)) continue;
      cleaned[key] = walk(child);
    }
    return cleaned;
  }
  return walk(value);
}

// ── SEC EDGAR helpers ──────────────────────────────────────────────────
const SEC_BASE = 'https://data.sec.gov';
const SEC_EFTS_BASE = 'https://efts.sec.gov/LATEST';
const SEC_HEADERS = {
  'User-Agent': 'Dexter/1.0 (research@example.com)',
  'Accept': 'application/json',
};

async function fetchSEC(url: string): Promise<any> {
  const resp = await fetch(url, { headers: SEC_HEADERS });
  if (!resp.ok) throw new Error(`SEC EDGAR error: ${resp.status} ${resp.statusText} for ${url}`);
  return resp.json();
}

/** Get company CIK from ticker (SEC uses CIK as primary key) */
async function tickerToCIK(ticker: string): Promise<string> {
  const url = `${SEC_BASE}/submissions/CIK${ticker.toUpperCase()}.json`;
  try {
    // SEC has a ticker→CIK mapping via company tickers JSON
    const tickerResp = await fetch('https://www.sec.gov/files/company_tickers.json', { headers: SEC_HEADERS });
    const tickers = await tickerResp.json() as Record<string, { cik_str: number; ticker: string }>;
    for (const entry of Object.values(tickers)) {
      if (entry.ticker.toUpperCase() === ticker.toUpperCase()) {
        return String(entry.cik_str).padStart(10, '0');
      }
    }
    throw new Error(`Ticker ${ticker} not found in SEC database`);
  } catch (e) {
    throw new Error(`Failed to resolve CIK for ${ticker}: ${e}`);
  }
}

// ── Yahoo Finance helpers ──────────────────────────────────────────────

function mapYahooIncomeStatement(stmt: any): Record<string, unknown> {
  return {
    ticker: stmt.ticker || '',
    report_period: stmt.endDate || '',
    revenues: stmt.totalRevenue || null,
    cost_of_revenue: stmt.costOfRevenue || null,
    gross_profit: stmt.grossProfit || null,
    operating_income: stmt.operatingIncome || null,
    net_income: stmt.netIncome || null,
    ebitda: stmt.ebitda || null,
    eps_basic: stmt.basicEps || null,
    eps_diluted: stmt.dilutedEps || null,
    research_and_development: stmt.researchDevelopment || null,
    selling_general_and_administrative: stmt.sellingGeneralAdministrative || null,
    interest_expense: stmt.interestExpense || null,
    income_tax_expense: stmt.incomeTaxExpense || null,
  };
}

function mapYahooBalanceSheet(stmt: any): Record<string, unknown> {
  return {
    ticker: stmt.ticker || '',
    report_period: stmt.endDate || '',
    total_assets: stmt.totalAssets || null,
    total_liabilities: stmt.totalLiab || null,
    total_equity: stmt.totalStockholderEquity || null,
    cash_and_equivalents: stmt.cash || null,
    total_debt: stmt.totalDebt || null,
    net_debt: stmt.netDebt || null,
    total_current_assets: stmt.totalCurrentAssets || null,
    total_current_liabilities: stmt.totalCurrentLiabilities || null,
    retained_earnings: stmt.retainedEarnings || null,
    common_stock_shares_outstanding: stmt.sharesIssued || null,
  };
}

function mapYahooCashFlow(stmt: any): Record<string, unknown> {
  return {
    ticker: stmt.ticker || '',
    report_period: stmt.endDate || '',
    operating_cash_flow: stmt.totalCashFromOperatingActivities || null,
    capital_expenditure: stmt.capitalExpenditures || null,
    free_cash_flow: stmt.freeCashFlow || null,
    investing_cash_flow: stmt.totalCashflowsFromInvestingActivities || null,
    financing_cash_flow: stmt.totalCashFromFinancingActivities || null,
    dividends_paid: stmt.dividendsPaid || null,
    share_repurchases: stmt.repurchaseOfStock || null,
  };
}

// ── Endpoint router ────────────────────────────────────────────────────

type Params = Record<string, string | number | string[] | undefined>;

/** Route map: endpoint → free data fetcher */
const ENDPOINT_HANDLERS: Record<string, (params: Params) => Promise<ApiResponse>> = {

  // ── Stock Prices ──
  '/prices/snapshot/': async (params) => {
    const ticker = String(params.ticker);
    const quote = await yahooFinance.quote(ticker) as any;
    const snapshot = {
      ticker,
      price: quote.regularMarketPrice,
      open: quote.regularMarketOpen,
      high: quote.regularMarketDayHigh,
      low: quote.regularMarketDayLow,
      close: quote.regularMarketPreviousClose,
      volume: quote.regularMarketVolume,
      market_cap: quote.marketCap,
      time: quote.regularMarketTime,
    };
    return { data: { snapshot }, url: `yahoo-finance://${ticker}/quote` };
  },

  '/prices/': async (params) => {
    const ticker = String(params.ticker);
    const interval = String(params.interval || 'day');
    const intervalMap: Record<string, string> = { day: '1d', week: '1wk', month: '1mo', year: '1mo' };
    const result = await yahooFinance.historical(ticker, {
      period1: String(params.start_date),
      period2: String(params.end_date),
      interval: (intervalMap[interval] || '1d') as any,
    }) as any[];
    const prices = result.map((bar: any) => ({
      date: bar.date?.toISOString?.()?.split('T')[0] || '',
      open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume,
    }));
    return { data: { prices }, url: `yahoo-finance://${ticker}/historical` };
  },

  '/prices/snapshot/tickers/': async () => {
    // Return a list of common tickers — Yahoo doesn't have a ticker list endpoint
    const common = ['AAPL','MSFT','NVDA','GOOGL','AMZN','META','TSLA','BRK-B','JPM','V','UNH','XOM','JNJ','WMT','PG','MA','HD','CVX','MRK','ABBV','KO','PEP','COST','AVGO','LLY','TMO','MCD','CSCO','ACN','ABT'];
    return { data: { tickers: common }, url: 'yahoo-finance://tickers/common' };
  },

  // ── Financial Statements ──
  '/financials/income-statements/': async (params) => {
    const ticker = String(params.ticker);
    const period = String(params.period || 'annual');
    const limit = Number(params.limit || 4);
    const mod = period === 'quarterly' ? 'quarterlyFinancials' : 'annualFinancials';
    const result = await yahooFinance.quoteSummary(ticker, { modules: ['incomeStatementHistory', 'incomeStatementHistoryQuarterly'] }) as any;
    const stmts = period === 'quarterly'
      ? result.incomeStatementHistoryQuarterly?.incomeStatementHistory || []
      : result.incomeStatementHistory?.incomeStatementHistory || [];
    const mapped = stmts.slice(0, limit).map((s: any) => mapYahooIncomeStatement({ ...s, ticker }));
    return { data: { income_statements: mapped }, url: `yahoo-finance://${ticker}/income-statements` };
  },

  '/financials/balance-sheets/': async (params) => {
    const ticker = String(params.ticker);
    const period = String(params.period || 'annual');
    const limit = Number(params.limit || 4);
    const result = await yahooFinance.quoteSummary(ticker, { modules: ['balanceSheetHistory', 'balanceSheetHistoryQuarterly'] }) as any;
    const stmts = period === 'quarterly'
      ? result.balanceSheetHistoryQuarterly?.balanceSheetStatements || []
      : result.balanceSheetHistory?.balanceSheetStatements || [];
    const mapped = stmts.slice(0, limit).map((s: any) => mapYahooBalanceSheet({ ...s, ticker }));
    return { data: { balance_sheets: mapped }, url: `yahoo-finance://${ticker}/balance-sheets` };
  },

  '/financials/cash-flow-statements/': async (params) => {
    const ticker = String(params.ticker);
    const period = String(params.period || 'annual');
    const limit = Number(params.limit || 4);
    const result = await yahooFinance.quoteSummary(ticker, { modules: ['cashflowStatementHistory', 'cashflowStatementHistoryQuarterly'] }) as any;
    const stmts = period === 'quarterly'
      ? result.cashflowStatementHistoryQuarterly?.cashflowStatements || []
      : result.cashflowStatementHistory?.cashflowStatements || [];
    const mapped = stmts.slice(0, limit).map((s: any) => mapYahooCashFlow({ ...s, ticker }));
    return { data: { cash_flow_statements: mapped }, url: `yahoo-finance://${ticker}/cash-flow` };
  },

  '/financials/': async (params) => {
    // All three financial statements combined
    const ticker = String(params.ticker);
    const period = String(params.period || 'annual');
    const limit = Number(params.limit || 4);
    const result = await yahooFinance.quoteSummary(ticker, {
      modules: [
        'incomeStatementHistory', 'incomeStatementHistoryQuarterly',
        'balanceSheetHistory', 'balanceSheetHistoryQuarterly',
        'cashflowStatementHistory', 'cashflowStatementHistoryQuarterly',
      ],
    }) as any;
    const isQ = period === 'quarterly';

    const income = (isQ ? result.incomeStatementHistoryQuarterly?.incomeStatementHistory : result.incomeStatementHistory?.incomeStatementHistory) || [];
    const balance = (isQ ? result.balanceSheetHistoryQuarterly?.balanceSheetStatements : result.balanceSheetHistory?.balanceSheetStatements) || [];
    const cashflow = (isQ ? result.cashflowStatementHistoryQuarterly?.cashflowStatements : result.cashflowStatementHistory?.cashflowStatements) || [];

    return {
      data: {
        financials: {
          income_statements: income.slice(0, limit).map((s: any) => mapYahooIncomeStatement({ ...s, ticker })),
          balance_sheets: balance.slice(0, limit).map((s: any) => mapYahooBalanceSheet({ ...s, ticker })),
          cash_flow_statements: cashflow.slice(0, limit).map((s: any) => mapYahooCashFlow({ ...s, ticker })),
        },
      },
      url: `yahoo-finance://${ticker}/financials`,
    };
  },

  // ── Key Ratios / Financial Metrics ──
  '/financial-metrics/snapshot/': async (params) => {
    const ticker = String(params.ticker);
    const result = await yahooFinance.quoteSummary(ticker, {
      modules: ['defaultKeyStatistics', 'financialData', 'summaryDetail'],
    }) as any;
    const ks = result.defaultKeyStatistics || {} as any;
    const fd = result.financialData || {} as any;
    const sd = result.summaryDetail || {} as any;

    const snapshot = {
      ticker,
      market_cap: sd.marketCap,
      pe_ratio: sd.trailingPE,
      forward_pe: sd.forwardPE,
      peg_ratio: ks.pegRatio,
      price_to_book: ks.priceToBook,
      price_to_sales: sd.priceToSalesTrailing12Months,
      enterprise_value: ks.enterpriseValue,
      ev_to_ebitda: ks.enterpriseToEbitda,
      ev_to_revenue: ks.enterpriseToRevenue,
      profit_margin: fd.profitMargins,
      operating_margin: fd.operatingMargins,
      gross_margin: fd.grossMargins,
      return_on_equity: fd.returnOnEquity,
      return_on_assets: fd.returnOnAssets,
      current_ratio: fd.currentRatio,
      debt_to_equity: fd.debtToEquity,
      beta: ks.beta,
      eps_trailing: sd.trailingEps,
      eps_forward: sd.forwardEps,
      dividend_yield: sd.dividendYield,
      revenue_growth: fd.revenueGrowth,
      earnings_growth: fd.earningsGrowth,
    };
    return { data: { snapshot }, url: `yahoo-finance://${ticker}/key-ratios` };
  },

  '/financial-metrics/': async (params) => {
    // Historical key ratios — return current snapshot as array (Yahoo doesn't provide historical ratios easily)
    const ticker = String(params.ticker);
    const snapshotResp = await ENDPOINT_HANDLERS['/financial-metrics/snapshot/']!(params);
    return { data: { financial_metrics: [snapshotResp.data.snapshot] }, url: `yahoo-finance://${ticker}/financial-metrics` };
  },

  // ── Insider Trades → SEC EDGAR Form 4 ──
  '/insider-trades/': async (params) => {
    const ticker = String(params.ticker).toUpperCase();
    const limit = Number(params.limit || 10);
    try {
      const cik = await tickerToCIK(ticker);
      const submissions = await fetchSEC(`${SEC_BASE}/submissions/CIK${cik}.json`);
      const recent = submissions.filings?.recent || {};
      const forms = recent.form || [];
      const dates = recent.filingDate || [];
      const accessions = recent.accessionNumber || [];

      // Filter for Form 4 filings
      const trades: any[] = [];
      for (let i = 0; i < forms.length && trades.length < limit; i++) {
        if (forms[i] === '4') {
          trades.push({
            ticker,
            filing_date: dates[i],
            accession_number: accessions[i],
            form_type: '4',
            filing_url: `https://www.sec.gov/Archives/edgar/data/${parseInt(cik)}/` +
              accessions[i].replace(/-/g, '/') + '/index.json',
          });
        }
      }
      return { data: { insider_trades: trades }, url: `sec-edgar://${ticker}/form-4` };
    } catch (e) {
      logger.warn(`[SEC EDGAR] insider trades fallback for ${ticker}: ${e}`);
      return { data: { insider_trades: [] }, url: `sec-edgar://${ticker}/form-4` };
    }
  },

  // ── SEC Filings ──
  '/filings/': async (params) => {
    const ticker = String(params.ticker).toUpperCase();
    const limit = Number(params.limit || 10);
    const filingTypes = params.filing_type
      ? (Array.isArray(params.filing_type) ? params.filing_type : [String(params.filing_type)])
      : [];
    try {
      const cik = await tickerToCIK(ticker);
      const submissions = await fetchSEC(`${SEC_BASE}/submissions/CIK${cik}.json`);
      const recent = submissions.filings?.recent || {};
      const forms = recent.form || [];
      const dates = recent.filingDate || [];
      const accessions = recent.accessionNumber || [];
      const descriptions = recent.primaryDocDescription || [];

      const filings: any[] = [];
      for (let i = 0; i < forms.length && filings.length < limit; i++) {
        if (filingTypes.length === 0 || filingTypes.includes(forms[i])) {
          filings.push({
            ticker,
            filing_type: forms[i],
            filing_date: dates[i],
            accession_number: accessions[i],
            description: descriptions[i] || '',
            filing_url: `https://www.sec.gov/Archives/edgar/data/${parseInt(cik)}/` +
              accessions[i].replace(/-/g, '/'),
          });
        }
      }
      return { data: { filings }, url: `sec-edgar://${ticker}/filings` };
    } catch (e) {
      logger.warn(`[SEC EDGAR] filings fallback for ${ticker}: ${e}`);
      return { data: { filings: [] }, url: `sec-edgar://${ticker}/filings` };
    }
  },

  '/filings/items/': async (params) => {
    // Filing items (text content) — fetch from SEC EDGAR directly
    const ticker = String(params.ticker).toUpperCase();
    const accNum = String(params.accession_number);
    const cik = await tickerToCIK(ticker);
    const cleanAccNum = accNum.replace(/-/g, '');
    const url = `${SEC_BASE}/Archives/edgar/data/${parseInt(cik)}/${cleanAccNum}/index.json`;
    try {
      const indexData = await fetchSEC(url);
      const items = indexData.directory?.item || [];
      return { data: { items, ticker, accession_number: accNum }, url };
    } catch (e) {
      return { data: { items: [], error: String(e) }, url };
    }
  },

  '/filings/items/types/': async () => {
    // Static mapping of filing item types
    return {
      data: {
        '10-K': [
          { name: 'Item-1', title: 'Business', description: 'Overview of company operations' },
          { name: 'Item-1A', title: 'Risk Factors', description: 'Key risks facing the company' },
          { name: 'Item-7', title: 'MD&A', description: "Management's Discussion and Analysis" },
          { name: 'Item-8', title: 'Financial Statements', description: 'Audited financial statements' },
        ],
        '10-Q': [
          { name: 'Part-1,Item-1', title: 'Financial Statements', description: 'Unaudited financial statements' },
          { name: 'Part-1,Item-2', title: 'MD&A', description: "Management's Discussion and Analysis" },
          { name: 'Part-2,Item-1A', title: 'Risk Factors', description: 'Updated risk factors' },
        ],
      },
      url: 'static://filing-item-types',
    };
  },

  // ── Earnings ──
  '/earnings': async (params) => {
    const ticker = String(params.ticker);
    const result = await yahooFinance.quoteSummary(ticker, { modules: ['earnings', 'earningsHistory'] }) as any;
    const earningsData = result.earnings || {} as any;
    return { data: { earnings: earningsData }, url: `yahoo-finance://${ticker}/earnings` };
  },

  // ── Analyst Estimates ──
  '/analyst-estimates/': async (params) => {
    const ticker = String(params.ticker);
    const result = await yahooFinance.quoteSummary(ticker, {
      modules: ['earningsTrend', 'recommendationTrend'],
    }) as any;
    const estimates = {
      ticker,
      earnings_trend: result.earningsTrend?.trend || [],
      recommendation_trend: result.recommendationTrend?.trend || [],
    };
    return { data: { analyst_estimates: [estimates] }, url: `yahoo-finance://${ticker}/analyst-estimates` };
  },

  // ── News → Yahoo Finance ──
  '/news': async (params) => {
    const ticker = String(params.ticker);
    const limit = Math.min(Number(params.limit || 5), 10);
    try {
      const result = await yahooFinance.search(ticker, { newsCount: limit }) as any;
      const news = (result.news || []).map((item: any) => ({
        title: item.title,
        source: item.publisher,
        published_at: item.providerPublishTime,
        url: item.link,
        thumbnail: item.thumbnail?.resolutions?.[0]?.url,
      }));
      return { data: { news }, url: `yahoo-finance://${ticker}/news` };
    } catch (e) {
      return { data: { news: [] }, url: `yahoo-finance://${ticker}/news` };
    }
  },

  // ── Segmented Revenue → SEC EDGAR XBRL ──
  '/financials/segmented-revenues/': async (params) => {
    const ticker = String(params.ticker);
    // Yahoo doesn't have segment data — try SEC companyfacts
    try {
      const cik = await tickerToCIK(ticker);
      const facts = await fetchSEC(`${SEC_BASE}/api/xbrl/companyfacts/CIK${cik}.json`);
      // Extract revenue segments from XBRL facts
      const usgaap = facts?.facts?.['us-gaap'] || {};
      const revenueKeys = Object.keys(usgaap).filter(k =>
        k.toLowerCase().includes('revenue') && usgaap[k]?.units?.USD
      );
      const segments: Record<string, any> = {};
      for (const key of revenueKeys.slice(0, 10)) {
        const units = usgaap[key].units.USD;
        segments[key] = units.slice(-Number(params.limit || 4));
      }
      return { data: { segmented_revenues: segments }, url: `sec-edgar://${ticker}/xbrl/revenue-segments` };
    } catch (e) {
      return { data: { segmented_revenues: {} }, url: `sec-edgar://${ticker}/segments` };
    }
  },

  // ── Institutional Ownership → SEC 13F ──
  // (Same pattern as insider trades — search for 13F filings)

  // ── Stock Screener ──
  '/financials/search/': async (params) => {
    // Basic screener via Yahoo — limited but functional
    return { data: { results: [], note: 'Screener not available in free mode — use specific ticker queries instead' }, url: 'free-api://screener' };
  },
};

// ── Main API object (drop-in replacement) ──────────────────────────────

export const api = {
  async get(
    endpoint: string,
    params: Params,
    options?: { cacheable?: boolean },
  ): Promise<ApiResponse> {
    const label = describeRequest(endpoint, params);

    // Check cache first
    if (options?.cacheable) {
      const cached = readCache(endpoint, params);
      if (cached) return cached;
    }

    // Find handler for this endpoint
    const handler = ENDPOINT_HANDLERS[endpoint];
    if (!handler) {
      logger.warn(`[FREE-API] No handler for endpoint: ${endpoint} — returning empty`);
      return { data: {}, url: `free-api://unhandled${endpoint}` };
    }

    logger.info(`[FREE-API] ${label}`);
    const result = await handler(params);

    // Cache if requested
    if (options?.cacheable) {
      writeCache(endpoint, params, result.data, result.url);
    }

    return result;
  },

  async post(
    endpoint: string,
    body: Record<string, unknown>,
  ): Promise<ApiResponse> {
    logger.warn(`[FREE-API] POST not supported for free tier: ${endpoint}`);
    return { data: {}, url: `free-api://post${endpoint}` };
  },
};

/** @deprecated Use `api.get` instead */
export const callApi = api.get;

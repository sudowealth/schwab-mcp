import {
	buildAccountDisplayMap,
	scrubAccountIdentifiers,
	GetAccountByNumberParams,
	GetAccountNumbersParams,
	GetOrdersParams,
	GetAccountsParams,
	GetOrdersByAccountParams,
	GetOrderByIdParams,
	CancelOrderParams,
	ReplaceOrderParams,
	GetTransactionsParams,
	GetTransactionByIdParams,
	GetUserPreferenceParams,
} from '@sudowealth/schwab-api'
import { z } from 'zod'
import { logger } from '../../shared/log'
import { createToolSpec } from '../types'

// ============================================================================
// Minimal Order Schema for placeOrder
// The @sudowealth/schwab-api PlaceOrderParams requires ALL 30+ fields,
// but Schwab's API only needs a subset. This minimal schema matches what
// the API actually requires for common order types.
// ============================================================================

const OrderInstrumentSchema = z.object({
	assetType: z.enum(['EQUITY', 'OPTION', 'MUTUAL_FUND', 'FIXED_INCOME', 'INDEX', 'CASH_EQUIVALENT', 'CURRENCY', 'COLLECTIVE_INVESTMENT']),
	symbol: z.string(),
	// Optional fields that may be needed for options
	cusip: z.string().optional(),
	description: z.string().optional(),
	instrumentId: z.number().optional(),
	netChange: z.number().optional(),
	// Option-specific fields
	putCall: z.enum(['PUT', 'CALL', 'UNKNOWN']).optional(),
	optionMultiplier: z.number().optional(),
	type: z.enum(['VANILLA', 'BINARY', 'BARRIER', 'UNKNOWN']).optional(),
	underlyingSymbol: z.string().optional(),
})

const OrderLegSchema = z.object({
	instruction: z.enum([
		'BUY', 'SELL', 'BUY_TO_COVER', 'SELL_SHORT',
		'BUY_TO_OPEN', 'BUY_TO_CLOSE', 'SELL_TO_OPEN', 'SELL_TO_CLOSE',
		'EXCHANGE', 'SELL_SHORT_EXEMPT'
	]),
	quantity: z.number(),
	instrument: OrderInstrumentSchema,
	// Optional fields
	orderLegType: z.enum(['EQUITY', 'OPTION', 'INDEX', 'MUTUAL_FUND', 'CASH_EQUIVALENT', 'FIXED_INCOME', 'CURRENCY', 'COLLECTIVE_INVESTMENT']).optional(),
	legId: z.number().optional(),
	positionEffect: z.enum(['OPENING', 'CLOSING', 'AUTOMATIC']).optional(),
	quantityType: z.enum(['ALL_SHARES', 'DOLLARS', 'SHARES']).optional(),
})

const MinimalPlaceOrderParams = z.object({
	// Required: Account to place order in
	accountNumber: z.string().describe('Encrypted account hash from getAccountNumbers'),
	
	// Required: Core order fields
	orderType: z.enum(['MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT', 'TRAILING_STOP', 'CABINET', 'NON_MARKETABLE', 'MARKET_ON_CLOSE', 'EXERCISE', 'TRAILING_STOP_LIMIT', 'NET_DEBIT', 'NET_CREDIT', 'NET_ZERO', 'LIMIT_ON_CLOSE'])
		.describe('Order type - use MARKET for market orders, LIMIT for limit orders'),
	session: z.enum(['NORMAL', 'AM', 'PM', 'SEAMLESS'])
		.describe('Trading session - use NORMAL for regular market hours'),
	duration: z.enum(['DAY', 'GOOD_TILL_CANCEL', 'FILL_OR_KILL', 'IMMEDIATE_OR_CANCEL', 'END_OF_WEEK', 'END_OF_MONTH', 'NEXT_END_OF_MONTH', 'UNKNOWN'])
		.describe('How long the order stays active - use DAY for day orders'),
	orderStrategyType: z.enum(['SINGLE', 'CANCEL', 'RECALL', 'PAIR', 'FLATTEN', 'TWO_DAY_SWAP', 'BLAST_ALL', 'OCO', 'TRIGGER'])
		.describe('Order strategy - use SINGLE for simple orders'),
	
	// Required: What to buy/sell
	orderLegCollection: z.array(OrderLegSchema).min(1)
		.describe('Array of order legs - at minimum needs instruction, quantity, and instrument'),
	
	// Optional: Price fields (required for LIMIT/STOP orders)
	price: z.number().optional().describe('Limit price - required for LIMIT orders'),
	stopPrice: z.number().optional().describe('Stop price - required for STOP/STOP_LIMIT orders'),
	
	// Optional: Additional fields
	complexOrderStrategyType: z.enum(['NONE', 'COVERED', 'VERTICAL', 'BACK_RATIO', 'CALENDAR', 'DIAGONAL', 'STRADDLE', 'STRANGLE', 'COLLAR_SYNTHETIC', 'BUTTERFLY', 'CONDOR', 'IRON_CONDOR', 'VERTICAL_ROLL', 'COLLAR_WITH_STOCK', 'DOUBLE_DIAGONAL', 'UNBALANCED_BUTTERFLY', 'UNBALANCED_CONDOR', 'UNBALANCED_IRON_CONDOR', 'UNBALANCED_VERTICAL_ROLL', 'MUTUAL_FUND_SWAP', 'CUSTOM']).optional(),
	taxLotMethod: z.enum(['FIFO', 'LIFO', 'HIGH_COST', 'LOW_COST', 'AVERAGE_COST', 'SPECIFIC_LOT', 'LOSS_HARVESTER']).optional(),
	specialInstruction: z.enum(['ALL_OR_NONE', 'DO_NOT_REDUCE', 'ALL_OR_NONE_DO_NOT_REDUCE']).optional(),
	requestedDestination: z.enum(['INET', 'ECN_ARCA', 'CBOE', 'AMEX', 'PHLX', 'ISE', 'BOX', 'NYSE', 'NASDAQ', 'BATS', 'C2', 'AUTO']).optional(),
})

export const toolSpecs = [
	createToolSpec({
		name: 'getAccounts',
		description: 'Get accounts',
		schema: GetAccountsParams,
		call: async (c, p) => {
			logger.info('[getAccounts] Fetching accounts', {
				showPositions: p?.fields,
			})
			const accounts = await c.trader.accounts.getAccounts({
				queryParams: { fields: p?.fields },
			})
			const accountSummaries = accounts.map((acc) => ({
				...acc.securitiesAccount,
			}))
			const displayMap = await buildAccountDisplayMap(c)
			return scrubAccountIdentifiers(accountSummaries, displayMap)
		},
	}),
	createToolSpec({
		name: 'getAccountNumbers',
		description: 'Get account numbers',
		schema: GetAccountNumbersParams,
		call: async (c, p) => {
			logger.info('[getAccountNumbers] Fetching account numbers')
			const accounts = await c.trader.accounts.getAccountNumbers(p)
			const displayMap = await buildAccountDisplayMap(c)
			return accounts.map((acc) => {
				return {
					accountDisplay: displayMap[acc.accountNumber],
					hashValue: acc.hashValue,
				}
			})
		},
	}),
	createToolSpec({
		name: 'getAccount',
		description: 'Get account',
		schema: GetAccountByNumberParams,
		call: async (c, p) => {
			const account = await c.trader.accounts.getAccountByNumber({
				pathParams: { accountNumber: p.accountNumber },
			})
			const displayMap = await buildAccountDisplayMap(c)
			return scrubAccountIdentifiers(account, displayMap)
		},
	}),
	createToolSpec({
		name: 'getOrders',
		description: 'Get orders',
		schema: GetOrdersParams,
		call: async (c, p) => {
			logger.info('[getOrders] Fetching orders', {
				maxResults: p.maxResults,
				hasDateFilter: !!p.fromEnteredTime || !!p.toEnteredTime,
			})
			const orders = await c.trader.orders.getOrders({ queryParams: p })
			const displayMap = await buildAccountDisplayMap(c)
			return scrubAccountIdentifiers(orders, displayMap)
		},
	}),
	createToolSpec({
		name: 'getOrdersByAccountNumber',
		description: 'Get orders by account number',
		schema: GetOrdersByAccountParams,
		call: async (c, p) => {
			const orders = await c.trader.orders.getOrdersByAccount({
				pathParams: { accountNumber: p.accountNumber },
				queryParams: p,
			})
			const displayMap = await buildAccountDisplayMap(c)
			return scrubAccountIdentifiers(orders, displayMap)
		},
	}),
	createToolSpec({
		name: 'placeOrder',
		description: `Place order for a specific account. 
Example market sell order:
{
  "accountNumber": "HASH_FROM_getAccountNumbers",
  "orderType": "MARKET",
  "session": "NORMAL", 
  "duration": "DAY",
  "orderStrategyType": "SINGLE",
  "orderLegCollection": [{
    "instruction": "SELL",
    "quantity": 5,
    "instrument": { "symbol": "TLRY", "assetType": "EQUITY" }
  }]
}`,
		schema: MinimalPlaceOrderParams,
		call: async (c, p) => {
			logger.info('[placeOrder] Placing order', {
				accountNumber: p.accountNumber.slice(0, 8) + '...',
				orderType: p.orderType,
				session: p.session,
				duration: p.duration,
				legs: p.orderLegCollection.map(leg => ({
					instruction: leg.instruction,
					quantity: leg.quantity,
					symbol: leg.instrument.symbol,
				})),
			})
			const order = await c.trader.orders.placeOrderForAccount({
				pathParams: { accountNumber: p.accountNumber },
				body: p as any, // Cast needed since we're using minimal schema
			})
			const displayMap = await buildAccountDisplayMap(c)
			return scrubAccountIdentifiers(order, displayMap)
		},
	}),
	createToolSpec({
		name: 'getOrder',
		description: 'Get order by order id for a specific account',
		schema: GetOrderByIdParams,
		call: async (c, p) => {
			const order = await c.trader.orders.getOrderByOrderId({
				pathParams: { accountNumber: p.accountNumber, orderId: p.orderId },
			})
			const displayMap = await buildAccountDisplayMap(c)
			return scrubAccountIdentifiers(order, displayMap)
		},
	}),
	createToolSpec({
		name: 'cancelOrder',
		description: 'Cancel order by order id for a specific account',
		schema: CancelOrderParams,
		call: async (c, p) => {
			const order = await c.trader.orders.cancelOrder({
				pathParams: { accountNumber: p.accountNumber, orderId: p.orderId },
			})
			const displayMap = await buildAccountDisplayMap(c)
			return scrubAccountIdentifiers(order, displayMap)
		},
	}),
	createToolSpec({
		name: 'replaceOrder',
		description: 'Replace order by order id for a specific account',
		schema: ReplaceOrderParams,
		call: async (c, p) => {
			const order = await c.trader.orders.replaceOrder({
				pathParams: { accountNumber: p.accountNumber, orderId: p.orderId },
				body: p,
			})
			const displayMap = await buildAccountDisplayMap(c)
			return scrubAccountIdentifiers(order, displayMap)
		},
	}),
	createToolSpec({
		name: 'getTransactions',
		description: 'Get transactions',
		schema: GetTransactionsParams,
		call: async (c, p) => {
			logger.info('[getTransactions] Fetching accounts')
			const accounts = await c.trader.accounts.getAccountNumbers()
			if (accounts.length === 0) return []
			logger.info('[getTransactions] Fetching transactions', {
				accountCount: accounts.length,
				startDate: p.startDate,
				endDate: p.endDate,
				hasType: !!p.types,
				symbol: p.symbol,
			})
			const transactions: unknown[] = []
			for (const account of accounts) {
				const accountTransactions = await c.trader.transactions.getTransactions(
					{
						pathParams: { accountNumber: account.hashValue },
						queryParams: {
							startDate: p.startDate,
							endDate: p.endDate,
							types: p.types,
							symbol: p.symbol,
						},
					},
				)
				logger.debug('[getTransactions] Transactions for account', {
					accountHash: account.hashValue,
					count: accountTransactions.length,
				})
				transactions.push(...accountTransactions)
			}
			const displayMap = await buildAccountDisplayMap(c)
			return scrubAccountIdentifiers(transactions, displayMap)
		},
	}),
	createToolSpec({
		name: 'getTransaction',
		description: 'Get transaction',
		schema: GetTransactionByIdParams,
		call: async (c, p) => {
			logger.info('[getTransaction] Fetching transaction', {
				transactionId: p.transactionId,
			})
		},
	}),
	createToolSpec({
		name: 'getUserPreference',
		description: 'Get user preference',
		schema: GetUserPreferenceParams,
		call: async (c, p) => {
			logger.info('[getUserPreference] Fetching user preference')
			const userPreference = await c.trader.userPreference.getUserPreference(p)
			if (userPreference.streamerInfo.length === 0) {
				return []
			}
			logger.info('[getUserPreference] User preference fetched', {
				hasAccounts: userPreference.accounts?.length > 0,
				accountCount: userPreference.accounts?.length || 0,
				hasStreamerInfo: userPreference.streamerInfo?.length > 0,
			})
			const displayMap = await buildAccountDisplayMap(c)
			return scrubAccountIdentifiers(userPreference, displayMap)
		},
	}),
] as const

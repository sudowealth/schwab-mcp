// Tool types
export * from './types'

// Auto-registration of tools
import * as market from './market'
import * as trader from './trader'

export const marketToolSpecs = market.toolSpecs
export const traderToolSpecs = trader.toolSpecs
export const allToolSpecs = [...trader.toolSpecs, ...market.toolSpecs]

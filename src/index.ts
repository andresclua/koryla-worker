import { routeAnalytics } from './analytics'

export interface Env {
  KORYLA_CONFIG: KVNamespace
  KORYLA_API_URL: string  // e.g. https://koryla.com
  KORYLA_API_KEY: string  // koryla_live_... (set via: wrangler secret put KORYLA_API_KEY)
}

export interface Rule {
  param: string
  value: string
}

interface Variant {
  id: string
  name: string
  traffic_weight: number
  target_url: string
  rules: Rule[]
}

interface AnalyticsDestination {
  type: string
  config: Record<string, string>
}

interface Experiment {
  id: string
  name: string
  base_url: string
  conversion_url: string | null
  override_assignment: boolean
  variants: Variant[]
  destinations: AnalyticsDestination[]
}

export function assignVariant(variants: Pick<Variant, 'id' | 'traffic_weight'>[]): string {
  const total = variants.reduce((sum, v) => sum + v.traffic_weight, 0)
  let rand = Math.random() * total
  for (const variant of variants) {
    rand -= variant.traffic_weight
    if (rand <= 0) return variant.id
  }
  return variants[variants.length - 1].id
}

export function findRuleMatch(
  variants: Pick<Variant, 'id' | 'rules'>[],
  searchParams: URLSearchParams
): typeof variants[number] | null {
  for (const variant of variants) {
    if (!variant.rules?.length) continue
    for (const rule of variant.rules) {
      if (searchParams.get(rule.param) === rule.value) return variant
    }
  }
  return null
}

const COOKIE_PREFIX = 'ky_'
const SESSION_COOKIE = 'ky_sid'
const CONFIG_TTL = 60

function getCookieName(experimentId: string): string {
  return `${COOKIE_PREFIX}${experimentId}`
}

function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {}
  return Object.fromEntries(
    header.split(';').map(c => c.trim().split('=').map(s => s.trim()))
  )
}

async function postEvent(env: Env, payload: {
  experiment_id: string
  variant_id: string
  session_id: string
  event_type: 'impression' | 'conversion'
}) {
  try {
    await fetch(`${env.KORYLA_API_URL}/api/worker/event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.KORYLA_API_KEY}`,
      },
      body: JSON.stringify(payload),
    })
  } catch {
    // fire-and-forget — never break the site
  }
}

async function getConfig(env: Env): Promise<Experiment[]> {
  const cached = await env.KORYLA_CONFIG.get('experiments', 'json')
  if (cached) return cached as Experiment[]

  let experiments: Experiment[]
  try {
    const res = await fetch(`${env.KORYLA_API_URL}/api/worker/config?type=edge`, {
      headers: { Authorization: `Bearer ${env.KORYLA_API_KEY}` },
    })
    if (!res.ok) return []
    experiments = await res.json() as Experiment[]
  } catch {
    return []
  }

  await env.KORYLA_CONFIG.put('experiments', JSON.stringify(experiments), {
    expirationTtl: CONFIG_TTL,
  })

  return experiments
}

function getPathname(urlOrPath: string): string {
  try { return new URL(urlOrPath).pathname } catch { return urlOrPath }
}

const EXCLUDED_PREFIXES = ['/api/', '/_nuxt/', '/.netlify/', '/login', '/signup']

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    if (EXCLUDED_PREFIXES.some(p => url.pathname.startsWith(p))) {
      return fetch(request)
    }

    const cookies = parseCookies(request.headers.get('cookie'))

    let sessionId = cookies[SESSION_COOKIE]
    let isNewSession = false
    if (!sessionId) {
      sessionId = crypto.randomUUID()
      isNewSession = true
    }

    const experiments = await getConfig(env)

    // Check conversion URLs
    for (const exp of experiments) {
      if (!exp.conversion_url) continue
      const convPathname = getPathname(exp.conversion_url)
      if (url.pathname === convPathname) {
        const variantId = cookies[getCookieName(exp.id)]
        if (variantId) {
          ctx.waitUntil(
            postEvent(env, {
              experiment_id: exp.id,
              variant_id: variantId,
              session_id: sessionId,
              event_type: 'conversion',
            })
          )
        }
      }
    }

    const experiment = experiments.find(e => url.pathname.startsWith(getPathname(e.base_url)))

    if (!experiment) {
      if (isNewSession) {
        const passthrough = await fetch(request)
        const res = new Response(passthrough.body, passthrough)
        res.headers.append('Set-Cookie', `${SESSION_COOKIE}=${sessionId}; Path=/; Max-Age=2592000; SameSite=Lax`)
        return res
      }
      return fetch(request)
    }

    const cookieName = getCookieName(experiment.id)
    let variantId = cookies[cookieName]
    let isNewAssignment = false

    const matchedVariant = findRuleMatch(experiment.variants, url.searchParams)

    if (matchedVariant && (!variantId || experiment.override_assignment)) {
      if (variantId !== matchedVariant.id) {
        variantId = matchedVariant.id
        isNewAssignment = true
      }
    } else if (!variantId) {
      variantId = assignVariant(experiment.variants)
      isNewAssignment = true
    }

    const variant = experiment.variants.find(v => v.id === variantId)
    if (!variant) return fetch(request)

    // Proxy to variant URL — no redirect, no flicker
    const response = await fetch(variant.target_url, {
      method: request.method,
      headers: request.headers,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
    })
    const newResponse = new Response(response.body, response)

    if (isNewSession) {
      newResponse.headers.append('Set-Cookie', `${SESSION_COOKIE}=${sessionId}; Path=/; Max-Age=2592000; SameSite=Lax`)
    }

    if (isNewAssignment) {
      newResponse.headers.append(
        'Set-Cookie',
        `${cookieName}=${variantId}; Path=/; Max-Age=2592000; SameSite=Lax`
      )

      ctx.waitUntil(
        Promise.all([
          postEvent(env, {
            experiment_id: experiment.id,
            variant_id: variant.id,
            session_id: sessionId,
            event_type: 'impression',
          }),
          routeAnalytics(experiment.destinations, {
            experimentId: experiment.id,
            experimentName: experiment.name,
            variantId: variant.id,
            variantName: variant.name,
            sessionId,
            timestamp: new Date().toISOString(),
          }),
        ])
      )
    }

    return newResponse
  },
}

export interface AnalyticsPayload {
  experimentId: string
  experimentName: string
  variantId: string
  variantName: string
  sessionId: string
  timestamp: string
}

interface Destination {
  type: string
  config: Record<string, string>
}

export async function routeAnalytics(destinations: Destination[], payload: AnalyticsPayload) {
  await Promise.allSettled(destinations.map(d => sendToDestination(d, payload)))
}

async function sendToDestination(dest: Destination, payload: AnalyticsPayload) {
  switch (dest.type) {
    case 'ga4':       return sendGA4(dest.config, payload)
    case 'posthog':   return sendPostHog(dest.config, payload)
    case 'mixpanel':  return sendMixpanel(dest.config, payload)
    case 'amplitude': return sendAmplitude(dest.config, payload)
    case 'plausible': return sendPlausible(dest.config, payload)
    case 'segment':   return sendSegment(dest.config, payload)
    case 'webhook':   return sendWebhook(dest.config, payload)
  }
}

async function sendGA4(config: Record<string, string>, p: AnalyticsPayload) {
  await fetch(`https://www.google-analytics.com/mp/collect?measurement_id=${config.measurement_id}&api_secret=${config.api_secret}`, {
    method: 'POST',
    body: JSON.stringify({
      client_id: p.sessionId,
      events: [{ name: 'experiment_assigned', params: {
        experiment_id: p.experimentId,
        experiment_name: p.experimentName,
        variant_id: p.variantId,
        variant_name: p.variantName,
        engagement_time_msec: 1,
      }}],
    }),
  })
}

async function sendPostHog(config: Record<string, string>, p: AnalyticsPayload) {
  await fetch(`${config.host ?? 'https://app.posthog.com'}/capture/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: config.api_key,
      event: '$experiment_started',
      distinct_id: p.sessionId,
      properties: {
        $feature_flag: p.experimentId,
        $feature_flag_response: p.variantName,
        experiment_name: p.experimentName,
      },
    }),
  })
}

async function sendMixpanel(config: Record<string, string>, p: AnalyticsPayload) {
  await fetch('https://api.mixpanel.com/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([{
      event: 'Experiment Assigned',
      properties: {
        token: config.token,
        distinct_id: p.sessionId,
        experiment_id: p.experimentId,
        experiment_name: p.experimentName,
        variant_id: p.variantId,
        variant_name: p.variantName,
      },
    }]),
  })
}

async function sendAmplitude(config: Record<string, string>, p: AnalyticsPayload) {
  await fetch('https://api2.amplitude.com/2/httpapi', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: config.api_key,
      events: [{
        user_id: p.sessionId,
        event_type: 'Experiment Assigned',
        event_properties: {
          experiment_id: p.experimentId,
          experiment_name: p.experimentName,
          variant_id: p.variantId,
          variant_name: p.variantName,
        },
      }],
    }),
  })
}

async function sendPlausible(config: Record<string, string>, p: AnalyticsPayload) {
  await fetch('https://plausible.io/api/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Koryla/1.0' },
    body: JSON.stringify({
      domain: config.domain,
      name: 'Experiment Assigned',
      url: `https://${config.domain}/`,
      props: { experiment: p.experimentName, variant: p.variantName },
    }),
  })
}

async function sendSegment(config: Record<string, string>, p: AnalyticsPayload) {
  const auth = btoa(config.write_key + ':')
  await fetch('https://api.segment.io/v1/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    body: JSON.stringify({
      userId: p.sessionId,
      event: 'Experiment Assigned',
      properties: { experimentId: p.experimentId, experimentName: p.experimentName, variantId: p.variantId, variantName: p.variantName },
      timestamp: p.timestamp,
    }),
  })
}

async function sendWebhook(config: Record<string, string>, p: AnalyticsPayload) {
  const body = JSON.stringify(p)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }

  if (config.secret) {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(config.secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    )
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
    headers['X-Koryla-Signature'] = 'sha256=' + Array.from(new Uint8Array(sig))
      .map(b => b.toString(16).padStart(2, '0')).join('')
  }

  if (config.headers) {
    try { Object.assign(headers, JSON.parse(config.headers)) } catch {}
  }

  await fetch(config.url, { method: 'POST', headers, body })
}

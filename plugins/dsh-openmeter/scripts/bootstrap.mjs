#!/usr/bin/env node
/**
 * Bootstrap the OpenMeter fork for the dsh-openmeter plugin (idempotent).
 *
 * Creates, when missing:
 *   1. the token meter            (v1  POST /api/v1/meters)
 *   2. the dsh_llm feature        (v3  POST /openmeter/features, unit_cost=llm)
 *   3. house + demo customers     (v1  POST /api/v1/customers, usageAttribution=subject)
 *   4. metered entitlements       (v2  POST .../entitlements, type=metered)
 *   5. an initial credit grant    (v2  POST .../grants) for DEMO_GRANT_AMOUNT > 0
 *
 * Usage: node scripts/bootstrap.mjs [endpoint]
 *        (env: OPENMETER_ENDPOINT, OPENMETER_TOKEN, DEMO_GRANT_AMOUNT)
 */

const ENDPOINT = (process.argv[2] ?? process.env.OPENMETER_ENDPOINT ?? 'http://127.0.0.1:8888').replace(/\/+$/, '')
const TOKEN = process.env.OPENMETER_TOKEN ?? ''
const HOUSE_SUBJECT = process.env.OPENMETER_HOUSE_SUBJECT ?? 'house'
const DEMO_CUSTOMER = process.env.DEMO_CUSTOMER ?? 'demo-cust'
const DEMO_GRANT_AMOUNT = Number(process.env.DEMO_GRANT_AMOUNT ?? 100000)
const FEATURE_KEY = process.env.OPENMETER_FEATURE_KEY ?? 'dsh_llm'
const METER_SLUG = process.env.OPENMETER_METER_SLUG ?? 'dsh_llm_tokens'
const EVENT_TYPE = process.env.OPENMETER_EVENT_TYPE ?? 'dsh.llm.call'

async function call(method, path, body) {
  const headers = { accept: 'application/json' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (TOKEN.length > 0) headers.authorization = `Bearer ${TOKEN}`
  const response = await fetch(ENDPOINT + path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  })
  const text = await response.text().catch(() => '')
  const payload = text.length === 0 ? undefined : JSON.parse(text)
  if (!response.ok) {
    const error = new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 300)}`)
    error.status = response.status
    throw error
  }
  return payload
}

async function step(label, run) {
  try {
    const result = await run()
    console.log(`✓ ${label}${result === undefined ? '' : ` (${result})`}`)
    return result
  } catch (error) {
    if (error.status === 409 || error.status === 412) {
      console.log(`• ${label}: already exists`)
      return undefined
    }
    throw error
  }
}

async function main() {
  console.log(`bootstrap → ${ENDPOINT}`)

  // 1. Meter (v1). Check by slug first.
  let meter
  try {
    meter = await call('GET', `/api/v1/meters/${METER_SLUG}`)
    console.log(`• meter ${METER_SLUG}: already exists`)
  } catch {
    meter = await step(`create meter ${METER_SLUG}`, () => call('POST', '/api/v1/meters', {
      slug: METER_SLUG,
      name: 'DSH LLM Tokens',
      description: 'Billed tokens per LLM call attributed to DSH sessions (input+cache read/write+output)',
      eventType: EVENT_TYPE,
      aggregation: 'SUM',
      valueProperty: '$.tokens',
      groupBy: {
        model: '$.model',
        provider: '$.provider',
        token_type: '$.token_type',
        purpose: '$.purpose',
        sessionId: '$.sessionId',
        rootSessionId: '$.rootSessionId',
        presetId: '$.presetId',
      },
    }))
  }
  let meterId = meter?.id
  if (meterId === undefined) {
    const again = await call('GET', `/api/v1/meters/${METER_SLUG}`)
    if (again?.id === undefined) throw new Error('meter id not resolvable')
    meterId = again.id
  }

  // 2. Feature (v3), linked to the meter with llm unit cost.
  const features = await call('GET', `/api/v3/openmeter/features?filter%5Bkey%5D%5Beq%5D=${FEATURE_KEY}`)
  const existingFeature = (features?.data ?? []).find(item => item?.key === FEATURE_KEY)
  if (existingFeature !== undefined) {
    console.log(`• feature ${FEATURE_KEY}: already exists`)
  } else {
    await step(`create feature ${FEATURE_KEY}`, () => call('POST', '/api/v3/openmeter/features', {
      key: FEATURE_KEY,
      name: 'DSH LLM Calls',
      description: 'Metered access to DSH model calls; unit cost resolved from the llm-cost catalog by provider+model',
      ...(meterId === undefined ? {} : { meter: { id: meterId } }),
      unit_cost: { type: 'llm', provider_property: 'provider', model_property: 'model', token_type_property: 'token_type' },
    }))
  }

  // 3. Customers (house + demo), subject-attributed by key.
  for (const [key, name] of [[HOUSE_SUBJECT, 'House (operator)'], [DEMO_CUSTOMER, 'Demo Customer']]) {
    const list = await call('GET', `/api/v1/customers?key=${encodeURIComponent(key)}`)
    const items = list?.items ?? list?.data ?? []
    if (items.some(item => item?.key === key)) {
      console.log(`• customer ${key}: already exists`)
    } else {
      await step(`create customer ${key}`, () => call('POST', '/api/v1/customers', {
        key,
        name,
        usageAttribution: { subjectKeys: [key] },
      }))
    }
  }

  // 4. Metered entitlements per customer (skip house if gated-out by design?
  //    House still gets one so its usage aggregates the same way; the plugin
  //    never blocks house locally).
  for (const key of [HOUSE_SUBJECT, DEMO_CUSTOMER]) {
    const list = await call('GET', `/api/v2/customers/${key}/entitlements`)
    const exists = (list?.items ?? []).some(item => item?.featureKey === FEATURE_KEY)
    if (exists) {
      console.log(`• entitlement ${key}/${FEATURE_KEY}: already exists`)
    } else {
      await step(`create entitlement ${key}/${FEATURE_KEY}`, () => call('POST', `/api/v2/customers/${key}/entitlements`, {
        type: 'metered',
        featureKey: FEATURE_KEY,
        isSoftLimit: false,
        usagePeriod: { interval: 'MONTH' },
      }))
    }
  }

  // 5. Initial credit grant for the demo customer.
  if (DEMO_GRANT_AMOUNT > 0) {
    await step(`grant ${DEMO_GRANT_AMOUNT} to ${DEMO_CUSTOMER}`, () => call('POST', `/api/v2/customers/${DEMO_CUSTOMER}/entitlements/${FEATURE_KEY}/grants`, {
      amount: DEMO_GRANT_AMOUNT,
      effectiveAt: new Date().toISOString(),
    }))
  }

  // 6. Verify the governance answer for the demo customer.
  const governance = await call('POST', '/api/v3/openmeter/governance/query', {
    include_credits: true,
    customer: { keys: [DEMO_CUSTOMER] },
    feature: { keys: [FEATURE_KEY] },
  })
  const access = governance?.data?.[0]?.features?.[FEATURE_KEY]
  console.log(`✓ governance ${DEMO_CUSTOMER}/${FEATURE_KEY}: has_access=${access?.has_access}`)
  if (access?.has_access !== true) {
    console.warn(`! expected access true, got ${JSON.stringify(access)}`)
  }
  console.log('bootstrap complete.')
}

main().catch(error => {
  console.error('bootstrap failed:', error.message)
  process.exitCode = 1
})

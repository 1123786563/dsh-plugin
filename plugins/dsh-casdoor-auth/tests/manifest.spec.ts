import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  name: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  dsh?: { bundle?: { patch?: string } }
}
const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')

describe('plugin manifest', () => {
  it('declares the bundle patch and the plugin name', () => {
    expect(pkg.name).toBe('dsh-casdoor-auth')
    expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
  })

  it('peers on cordis, schemastery, and the vendored multi-tenant runtime', () => {
    expect(pkg.peerDependencies?.['@deepseek-ai/cordis']).toBeDefined()
    expect(pkg.peerDependencies?.['@deepseek-ai/schemastery']).toBeDefined()
    expect(pkg.peerDependencies?.['dsh-multi-tenant']).toBeDefined()
  })

  it('bundles jose (the host does not provide it)', () => {
    expect(pkg.dependencies?.jose).toBeDefined()
  })
})

// One home for the port seam expression: the golden suite pins its raw yml
// line, the dialect suite pins its parsed !!js node.
const portExpr =
  'process.env.DSH_CASDOOR_DSH_PORT ? Number(process.env.DSH_CASDOOR_DSH_PORT) : 38080'

describe('cordis.patch.yml', () => {
  // Golden string pins the whole quoted ternary: env values are strings, so
  // the old `?? 38080` seam handed the webserver schema (z.natural().max(65535))
  // a string port and dsh boot failed; '' must take the default branch because
  // Number('') === 0 would request a random port. The quotes are load-bearing:
  // a plain `!!js` scalar containing " : " silently parses as an implicit
  // mapping under the host loader dialect (see the dialect suite below).
  const portSeam = `port: !!js '${portExpr}'`

  it('moves the webserver onto the loopback private port', () => {
    expect(patch).toContain('- id: webserver')
    expect(patch).toContain('host: 127.0.0.1')
    expect(patch).toContain(portSeam)
  })

  it('coerces DSH_CASDOOR_DSH_PORT to a number (golden, regression-pinned)', () => {
    expect(patch).toContain(portSeam)
    expect(patch).not.toContain('process.env.DSH_CASDOOR_DSH_PORT ?? 38080')
  })

  it('inserts the plugin row with env-driven defaults', () => {
    expect(patch).toContain('- id: casdoor-auth')
    expect(patch).toContain("name: dsh-casdoor-auth")
    expect(patch).toContain('DSH_CASDOOR_GATEWAY_JWKS_URL')
    expect(patch).toContain("identityPublicKey: !!js process.env.DSH_CASDOOR_IDENTITY_PUBLIC_KEY ?? ''")
  })

  it('injects the guard switch: DSH_CASDOOR_GUARD on only for 1/true, else off', () => {
    expect(patch).toContain(
      "guardEnabled: !!js process.env.DSH_CASDOOR_GUARD === '1' || process.env.DSH_CASDOOR_GUARD === 'true'",
    )
  })

  it('injects the gateway data dir with the unchanged verbatim default', () => {
    expect(patch).toContain(
      "gatewayDataDir: !!js process.env.DSH_CASDOOR_GATEWAY_DATA_DIR ?? '~/.dsh-casdoor-gateway'",
    )
  })
})

describe('cordis.patch.yml under the host loader dialect', () => {
  // The host parses bundle patch lists with the entry-list YAML dialect:
  // js-yaml JSON_SCHEMA extended with the !!js scalar type (app-boot
  // parsePatchList -> vendor/include entryListSchema). In that dialect a
  // plain `!!js` scalar containing " : " silently parses as an implicit
  // mapping — the unquoted port seam collapsed to { '[object Object]': 38080 }
  // and every profile mounting the patch failed webserver boot with no parse
  // error. Golden text cannot see that break; this layer re-parses the file
  // with the same dialect and pins each !!js node's full expression text.
  const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: (data) => typeof data === 'string',
    construct: (data) => ({ __jsExpr: data }),
    predicate: (data) => data instanceof Object && '__jsExpr' in data,
    represent: (data) => data['__jsExpr'],
  })
  const schema = yaml.JSON_SCHEMA.extend(JsExpr)

  interface PatchRow {
    id?: string
    config?: Record<string, unknown>
    insert?: PatchRow[]
  }
  const rows = yaml.load(patch, { schema }) as PatchRow[]
  const webserver = rows.find((row) => row.id === 'webserver')
  const plugin = rows.flatMap((row) => row.insert ?? []).find((row) => row.id === 'casdoor-auth')

  it('parses the port seam into one full !!js expression node', () => {
    expect(webserver?.config?.port).toEqual({ __jsExpr: portExpr })
  })

  it('parses every casdoor-auth config !!js key into one full expression node', () => {
    expect(plugin?.config).toEqual({
      gatewayJwksUrl: {
        __jsExpr: "process.env.DSH_CASDOOR_GATEWAY_JWKS_URL ?? 'http://127.0.0.1:3080/.well-known/jwks.json'",
      },
      identityPublicKey: { __jsExpr: "process.env.DSH_CASDOOR_IDENTITY_PUBLIC_KEY ?? ''" },
      identityHeader: { __jsExpr: "process.env.DSH_CASDOOR_IDENTITY_HEADER ?? 'x-dsh-identity'" },
      guardEnabled: {
        __jsExpr: "process.env.DSH_CASDOOR_GUARD === '1' || process.env.DSH_CASDOOR_GUARD === 'true'",
      },
      gatewayDataDir: { __jsExpr: "process.env.DSH_CASDOOR_GATEWAY_DATA_DIR ?? '~/.dsh-casdoor-gateway'" },
    })
  })
})

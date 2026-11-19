import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { parseEnv } from '../../../server/utils/env'

const CWD = '/srv/app'
const BASE = {
  BETTER_AUTH_SECRET: 'a-secret-long-enough-for-better-auth-0123',
  BETTER_AUTH_URL: 'http://localhost:3100',
  EMAIL_HOST: 'smtp.example.org',
  EMAIL_USER: 'user',
  EMAIL_PASS: 'pass',
  EMAIL_FROM: 'staffing@example.org',
}
const prod = (source: Record<string, string | undefined>) =>
  parseEnv(source, { dev: false, cwd: CWD })

describe('parseEnv', () => {
  it('fills the documented defaults', () => {
    const env = prod(BASE)
    expect(env).toMatchObject({
      DATABASE_URL: 'file:./dev.db',
      EMAIL_TRANSPORT: 'smtp',
      EMAIL_PORT: 587,
      EMAIL_SECURE: false,
      V4W_ADMIN_EMAILS: [],
      V4W_DATA_SOURCE: 'unlabeled',
      V4W_FORECAST_DIR: join(CWD, 'forecast'),
      V4W_PYTHON: 'python3', // no venv under /srv/app/forecast
      V4W_RETRAIN_MODULE: 'db.retrain',
      V4W_RETRAIN_ON_IMPORT: true,
      V4W_RETRAIN_SCHEDULE: 'on',
      V4W_RETRAIN_TIMEOUT_MIN: 60,
      V4W_UPLOAD_MAX_MB: 40,
      V4W_UPLOAD_MAX_ROWS: 750000,
    })
  })

  it('uses the forecast venv when it exists', () => {
    const repo = process.cwd()
    const env = parseEnv(
      { ...BASE, V4W_FORECAST_DIR: join(repo, 'forecast') },
      { dev: false, cwd: repo }
    )
    // In a checkout without pnpm forecast:setup there is no venv: python3.
    expect([join(repo, 'forecast', '.venv', 'bin', 'python'), 'python3']).toContain(env.V4W_PYTHON)
    expect(prod({ ...BASE, V4W_PYTHON: '/usr/bin/python3.12' }).V4W_PYTHON).toBe(
      '/usr/bin/python3.12'
    )
    expect(prod({ ...BASE, V4W_FORECAST_DIR: './py' }).V4W_FORECAST_DIR).toBe(join(CWD, 'py'))
    expect(prod({ ...BASE, V4W_PYTHON: './forecast/.venv/bin/python' }).V4W_PYTHON).toBe(
      join(CWD, 'forecast/.venv/bin/python')
    )
    expect(prod({ ...BASE, V4W_PYTHON: 'python3.12' }).V4W_PYTHON).toBe('python3.12')
  })

  it('reads explicit values', () => {
    const env = prod({
      ...BASE,
      EMAIL_PORT: '2525',
      EMAIL_SECURE: '1',
      V4W_DATA_SOURCE: ' Synthetic ',
      V4W_RETRAIN_ON_IMPORT: 'false',
      V4W_RETRAIN_SCHEDULE: 'off',
      V4W_UPLOAD_MAX_MB: '15.5',
    })
    expect(env).toMatchObject({
      EMAIL_PORT: 2525,
      EMAIL_SECURE: true,
      V4W_DATA_SOURCE: 'synthetic',
      V4W_RETRAIN_ON_IMPORT: false,
      V4W_RETRAIN_SCHEDULE: 'off',
      V4W_UPLOAD_MAX_MB: 15.5,
    })
    expect(prod({ ...BASE, V4W_DATA_SOURCE: 'real' }).V4W_DATA_SOURCE).toBe('unlabeled')
    expect(prod({ ...BASE, V4W_DATA_SOURCE: 'PARTNER' }).V4W_DATA_SOURCE).toBe('partner')
  })

  it('refuses the console transport outside nuxt dev', () => {
    expect(() => prod({ ...BASE, EMAIL_TRANSPORT: 'console' })).toThrow(
      /EMAIL_TRANSPORT: EMAIL_TRANSPORT=console is for `nuxt dev` only/
    )
    const dev = parseEnv(
      {
        BETTER_AUTH_SECRET: 's',
        BETTER_AUTH_URL: 'http://localhost:3100',
        EMAIL_TRANSPORT: 'console',
      },
      { dev: true, cwd: CWD }
    )
    expect(dev.EMAIL_TRANSPORT).toBe('console')
  })

  it('requires the SMTP fields only for smtp', () => {
    expect(() =>
      prod({ BETTER_AUTH_SECRET: 's', BETTER_AUTH_URL: 'http://localhost:3100' })
    ).toThrow(
      /EMAIL_HOST: is required[\s\S]*EMAIL_USER: is required[\s\S]*EMAIL_PASS: is required[\s\S]*EMAIL_FROM: is required/
    )
    expect(() =>
      parseEnv(
        {
          BETTER_AUTH_SECRET: 's',
          BETTER_AUTH_URL: 'http://localhost:3100',
          EMAIL_TRANSPORT: 'console',
        },
        { dev: true, cwd: CWD }
      )
    ).not.toThrow()
  })

  it('requires the auth secret and a URL', () => {
    expect(() => prod({ ...BASE, BETTER_AUTH_SECRET: '' })).toThrow(
      /BETTER_AUTH_SECRET: is required/
    )
    expect(() => prod({ ...BASE, BETTER_AUTH_URL: 'localhost' })).toThrow(
      /BETTER_AUTH_URL: must be a URL/
    )
  })

  it('parses the admin list', () => {
    expect(
      prod({ ...BASE, V4W_ADMIN_EMAILS: 'Admin@Example.org, b@example.org,admin@example.org' })
        .V4W_ADMIN_EMAILS
    ).toEqual(['admin@example.org', 'b@example.org'])
    expect(() => prod({ ...BASE, V4W_ADMIN_EMAILS: 'admin@example.org;b@example.org' })).toThrow(
      /V4W_ADMIN_EMAILS:/
    )
  })

  it('rejects a bad number or boolean, naming the variable', () => {
    expect(() => prod({ ...BASE, EMAIL_PORT: 'abc' })).toThrow(/EMAIL_PORT: must be an integer/)
    expect(() => prod({ ...BASE, V4W_UPLOAD_MAX_ROWS: '1.5' })).toThrow(/V4W_UPLOAD_MAX_ROWS/)
    expect(() => prod({ ...BASE, V4W_RETRAIN_TIMEOUT_MIN: '0' })).toThrow(/V4W_RETRAIN_TIMEOUT_MIN/)
    expect(() => prod({ ...BASE, EMAIL_SECURE: 'yes' })).toThrow(
      /EMAIL_SECURE: must be true, false, 1 or 0/
    )
    expect(() => prod({ ...BASE, V4W_RETRAIN_SCHEDULE: 'daily' })).toThrow(/V4W_RETRAIN_SCHEDULE/)
  })

  it('reports every problem at once in the template style', () => {
    expect(() => prod({})).toThrow(
      /^Invalid environment configuration:\n {2}- BETTER_AUTH_SECRET: is required\n {2}- BETTER_AUTH_URL: is required[\s\S]*Copy \.env\.example to \.env/
    )
  })
})

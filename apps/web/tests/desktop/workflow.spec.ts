import { test, expect, request, type APIRequestContext } from '@playwright/test'
import { writeFile, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

// Real application API with an IPC adapter owning isolated cookie jars.
// System dialogs and the Rust runtime are covered by the installed-app checklist.
test('desktop IPC: CSV/XLSX → профиль → экспорт → отмена → повтор → смена сервера', async ({ page }, testInfo) => {
  test.setTimeout(240_000)
  const origin = new URL(process.env.E2E_BASE_URL || 'http://127.0.0.1:5181').origin
  let serverUrl = origin + '/'
  let generation = 0
  let context: APIRequestContext = await request.newContext({ baseURL: serverUrl, extraHTTPHeaders: { Origin: origin } })
  let cancelSave = true
  let exportPath = ''
  let uploadedJobId = ''
  let releaseSwitch: (() => void) | undefined
  const contexts = [context]
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.exposeFunction('desktopTestInvoke', async (command: string, args: Record<string, any> = {}) => {
    if (command === 'desktop_connection') return { serverUrl, generation }
    if (args.generation !== generation) throw new Error('Сервер изменён. Войдите заново')
    if (command === 'desktop_check') {
      const response = await context.get('/api/v1/health/ready')
      expect(response.ok()).toBeTruthy()
      expect((await response.json()).status).toBe('ok')
      return
    }
    if (command === 'desktop_connect') {
      const next = new URL(args.serverUrl).origin + '/'
      if (next !== serverUrl) {
        await new Promise<void>(resolve => { releaseSwitch = resolve })
        context = await request.newContext({ baseURL: next, extraHTTPHeaders: { Origin: new URL(next).origin } })
        contexts.push(context)
        expect((await context.get('/api/v1/health/ready')).ok()).toBeTruthy()
        serverUrl = next
        generation++
      }
      return { serverUrl, generation }
    }
    if (command === 'desktop_save_export') {
      const response = await context.get(`/api/v1/exports/${args.exportId}/download`)
      expect(response.ok()).toBeTruthy()
      if (cancelSave) return false
      exportPath = testInfo.outputPath('audience.csv')
      await writeFile(exportPath, await response.body())
      return true
    }
    if (command === 'desktop_request') {
      const input = args.request
      const response = await context.fetch(input.path, {
        method: input.method,
        headers: input.headers,
        data: input.bodyBase64 ? Buffer.from(input.bodyBase64, 'base64') : undefined,
      })
      if (input.method === 'POST' && /^\/api\/v1\/sources\/[^/]+\/imports$/.test(input.path) && response.ok()) {
        uploadedJobId = (await response.json()).id
      }
      return { status: response.status(), headers: { 'content-type': response.headers()['content-type'] || '' }, bodyBase64: (await response.body()).toString('base64') }
    }
    throw new Error(`Unexpected command: ${command}`)
  })
  await page.addInitScript(() => {
    const target = window as unknown as { isTauri: boolean; desktopTestInvoke: (command: string, args?: unknown) => Promise<unknown>; __TAURI_INTERNALS__: unknown }
    target.isTauri = true
    target.__TAURI_INTERNALS__ = { invoke: (command: string, args?: unknown) => target.desktopTestInvoke(command, args) }
  })
  try {
    await page.goto('/')
    await page.getByLabel('Пароль', { exact: true }).fill(process.env.DEMO_PASSWORD || 'HryukersDemo2026!')
    await page.getByRole('button', { name: 'Войти в платформу' }).click()
    await expect(page.getByRole('heading', { name: 'Обзор платформы' })).toBeVisible()
    await expect.poll(async () => (await (await context.get('/api/v1/summary')).json()).customer_count,
      { timeout: 90_000 }).toBeGreaterThan(500)
    // All tenants now share phone/email/time; test both file formats on the same source.
    await page.getByRole('link', { name: 'Источники данных', exact: true }).click()
    const sources = (await (await context.get('/api/v1/sources')).json()).items
    const source = sources.find((value: { kind: string; coverage_to: string | null }) => value.kind === 'contacts' && value.coverage_to)
    expect(source).toBeTruthy()
    const time = new Date(new Date(source.coverage_to).getTime() - 60_000).toISOString()
    const files = [
      { name: 'contacts.csv', mimeType: 'text/csv', buffer: Buffer.from(`phone,email,time\n+79000000901,desktop-csv@example.invalid,${time}\n`) },
      { name: 'contacts.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: await readFile(new URL('../fixtures/contacts.xlsx', import.meta.url)) },
    ]
    for (const file of files) {
      uploadedJobId = ''
      await page.getByLabel(`Файл ${source.name}`, { exact: true }).setInputFiles(file)
      // Native requests run outside the page's browser network events.
      await expect.poll(() => uploadedJobId).not.toBe('')
      const jobId = uploadedJobId
      await expect.poll(async () => (await (await context.get(`/api/v1/imports/${jobId}`)).json()).status,
        { timeout: 90_000 }).toBe('succeeded')
      const job = await (await context.get(`/api/v1/imports/${jobId}`)).json()
      expect(job.accepted_rows + job.duplicate_rows).toBe(1)
      await expect(page.getByLabel(`Файл ${source.name}`, { exact: true })).toBeEnabled()
    }
    await page.getByRole('link', { name: 'Клиенты', exact: true }).click()
    await page.getByRole('textbox', { name: 'Поиск клиентов' }).fill('desktop-csv@example.invalid')
    await page.getByRole('link', { name: 'Открыть Клиент 0901', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Клиент 0901' })).toBeVisible()
    await expect(page.getByText('Взаимодействие', { exact: true })).toBeVisible()
    const radar = await (await context.get('/api/v1/radar')).json()
    let campaignId = ''
    for (const opportunity of radar.opportunities.filter((item: { offers: unknown[] }) => item.offers.length)) {
      const created = await context.post('/api/v1/radar/campaigns', { data: {
        opportunity_id: opportunity.id, offer_rule_id: opportunity.offers[0].rule_id,
        channel: 'sms', name: 'Desktop · Проверка сохранения', idempotency_key: randomUUID(),
      } })
      expect(created.ok()).toBeTruthy()
      const id = (await created.json()).campaign_id
      const preview = await (await context.get(`/api/v1/campaigns/${id}/preview`)).json()
      // Earlier browser checks may have already exported part of the shared test audience.
      if (preview.eligible_count > 0) { campaignId = id; break }
    }
    expect(campaignId, 'A test audience with SMS contacts outside cooldown is required').not.toBe('')
    await page.goto(`/#/campaigns?campaign=${campaignId}`)
    await expect(page.getByRole('heading', { name: 'Desktop · Проверка сохранения', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Сформировать CSV', exact: true }).click()
    const download = page.getByRole('button', { name: 'Скачать CSV', exact: true }).first()
    await download.click()
    await expect(page.getByRole('status').filter({ hasText: 'Сохранение отменено' })).toBeVisible()
    expect(exportPath).toBe('')
    const exportList = `/api/v1/campaigns/${campaignId}/exports`
    const exportsAfterCancel = await (await context.get(exportList)).json()
    cancelSave = false
    await download.click()
    await expect(page.getByRole('status').filter({ hasText: 'CSV сохранён' })).toBeVisible()
    expect(await readFile(exportPath, 'utf8')).toContain('+790000')
    expect((await (await context.get(exportList)).json()).total).toBe(exportsAfterCancel.total)
    // Same address is a health check and retains authentication.
    await page.getByRole('button', { name: 'Настройки', exact: true }).click()
    await page.getByRole('button', { name: 'Изменить сервер', exact: true }).click()
    await page.getByRole('button', { name: 'Сохранить и подключиться', exact: true }).click()
    await expect(page.getByLabel('Адрес сервера')).not.toBeVisible()
    await page.getByRole('button', { name: 'Готово', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Выйти', exact: true })).toBeVisible()
    // Another origin on the same isolated server still requires a fresh login.
    await page.getByRole('button', { name: 'Настройки', exact: true }).click()
    await page.getByRole('button', { name: 'Изменить сервер', exact: true }).click()
    const alternate = new URL(serverUrl)
    alternate.hostname = alternate.hostname === 'localhost' ? '127.0.0.1' : 'localhost'
    await page.getByLabel('Адрес сервера').fill(alternate.origin)
    await page.getByRole('button', { name: 'Сохранить и подключиться', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Проверяем сервер' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Desktop · Проверка сохранения', exact: true })).not.toBeVisible()
    await expect(page.getByRole('button', { name: 'Выйти', exact: true })).not.toBeVisible()
    await expect.poll(() => !!releaseSwitch).toBeTruthy()
    releaseSwitch!()
    await expect(page.getByRole('button', { name: 'Войти в платформу' })).toBeVisible()
    await expect(page).toHaveURL(/#\/$/)
    await expect(page.getByRole('link', { name: 'Клиенты', exact: true })).toHaveCount(0)
    expect(errors).toEqual([])
  } finally {
    releaseSwitch?.()
    await Promise.all(contexts.map(value => value.dispose()))
  }
})

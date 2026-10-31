import { test, expect, request, type APIRequestContext } from '@playwright/test'
import { writeFile, readFile } from 'node:fs/promises'

// Real application API with an IPC adapter owning isolated cookie jars.
// System dialogs and the Rust runtime are covered by the installed-app checklist.
test('desktop IPC: CSV/XLSX → профиль → экспорт → отмена → повтор → смена сервера', async ({ page }, testInfo) => {
  const origin = new URL(process.env.E2E_BASE_URL || 'http://127.0.0.1:5181').origin
  let serverUrl = origin + '/'
  let generation = 0
  let context: APIRequestContext = await request.newContext({ baseURL: serverUrl, extraHTTPHeaders: { Origin: origin } })
  let cancelSave = true
  let exportPath = ''
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
    const initial = await (await context.get('/api/v1/summary')).json()
    expect(initial.event_count, 'Use a fresh hryukers-e2e Compose project').toBe(0)
    // REST uses its actual synchronization API. CSV and XLSX use file selection.
    await page.getByRole('link', { name: 'Источники данных', exact: true }).click()
    const sources = (await (await context.get('/api/v1/sources')).json()).items
    const waitForSource = async (id: string) => {
      await expect.poll(async () => {
        const jobs = (await (await context.get('/api/v1/imports')).json()).items
        return jobs.find((job: { source_id: string }) => job.source_id === id)?.status || ''
      }, { timeout: 90_000 }).toMatch(/^(succeeded|completed_with_errors)$/)
    }
    await page.getByRole('button', { name: 'Синхронизировать API', exact: true }).click()
    await waitForSource(sources.find((value: { kind: string }) => value.kind === 'rest_api').id)
    for (const [kind, filename] of [['pos_xlsx', 'pos_B.xlsx'], ['crm_csv', 'crm_C_initial.csv']]) {
      const source = sources.find((value: { kind: string }) => value.kind === kind)
      const file = await context.get(`/api/v1/demo/files/${filename}`)
      expect(file.ok()).toBeTruthy()
      await page.getByLabel(`Файл ${source.name}`, { exact: true }).setInputFiles({ name: filename, mimeType: kind === 'pos_xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv', buffer: await file.body() })
      await waitForSource(source.id)
      await expect(page.getByLabel(`Файл ${source.name}`, { exact: true })).toBeEnabled()
    }
    await expect.poll(async () => (await (await context.get('/api/v1/summary')).json()).event_count, { timeout: 90_000 }).toBe(18)
    await page.getByRole('link', { name: 'Клиенты', exact: true }).click()
    await page.getByRole('textbox', { name: 'Поиск клиентов' }).fill('G001')
    await page.getByRole('link', { name: 'Открыть G001', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Посетитель 001' })).toBeVisible()
    await page.getByRole('link', { name: 'Кампании', exact: true }).click()
    await page.getByRole('button', { name: 'Сформировать CSV', exact: true }).click()
    const download = page.getByRole('button', { name: 'Скачать CSV', exact: true }).first()
    await download.click()
    await expect(page.getByRole('status').filter({ hasText: 'Сохранение отменено' })).toBeVisible()
    expect(exportPath).toBe('')
    const campaign = (await (await context.get('/api/v1/campaigns')).json()).items[0]
    const exportList = `/api/v1/campaigns/${campaign.id}/exports`
    const exportsAfterCancel = await (await context.get(exportList)).json()
    cancelSave = false
    await download.click()
    await expect(page.getByRole('status').filter({ hasText: 'CSV сохранён' })).toBeVisible()
    expect(await readFile(exportPath, 'utf8')).toContain('g001@example.invalid')
    expect((await (await context.get(exportList)).json()).total).toBe(exportsAfterCancel.total)
    // Same address is a health check and retains authentication.
    await page.getByRole('button', { name: 'Подключение к серверу', exact: true }).click()
    await page.getByRole('button', { name: 'Проверить и подключить', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Выйти', exact: true })).toBeVisible()
    // Another origin on the same isolated server still requires a fresh login.
    await page.getByRole('button', { name: 'Подключение к серверу', exact: true }).click()
    const alternate = new URL(serverUrl)
    alternate.hostname = alternate.hostname === 'localhost' ? '127.0.0.1' : 'localhost'
    await page.getByLabel('Адрес сервера').fill(alternate.origin)
    await page.getByRole('button', { name: 'Проверить и подключить', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Войти в платформу' })).toBeVisible()
    await expect(page).toHaveURL(/#\/$/)
    await expect(page.getByRole('link', { name: 'Клиенты', exact: true })).toHaveCount(0)
    expect(errors).toEqual([])
  } finally {
    await Promise.all(contexts.map(value => value.dispose()))
  }
})

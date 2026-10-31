import { test, expect } from '@playwright/test'

test('desktop UI использует IPC transport, hash-навигацию и настройки подключения', async ({ page }) => {
  // Contract test for frontend/IPC serialization. Native HTTP itself is tested in Rust.
  await page.addInitScript(() => {
    const target = window as unknown as { isTauri: boolean; __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } }
    target.isTauri = true
    target.__TAURI_INTERNALS__ = {
      invoke: async (command, args) => {
        if (command === 'desktop_connection') return { serverUrl: 'http://127.0.0.1:5181/' }
        if (command === 'desktop_connect') throw 'Сервер недоступен. Проверьте адрес и подключение'
        if (command !== 'desktop_request') throw new Error(`Unexpected command: ${command}`)
        const request = args!.request as { path: string; method: string; headers: Record<string, string>; bodyBase64: string | null }
        const body = request.bodyBase64 ? Uint8Array.from(atob(request.bodyBase64), c => c.charCodeAt(0)) : null
        const response = await fetch(request.path, { method: request.method, headers: request.headers, body, credentials: 'same-origin' })
        const bytes = new Uint8Array(await response.arrayBuffer())
        let text = ''
        for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768))
        return { status: response.status, headers: { 'content-type': response.headers.get('content-type') || '' }, bodyBase64: btoa(text) }
      },
    }
  })
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Подключение к серверу' })).toBeVisible()
  await page.getByLabel('Пароль', { exact: true }).fill(process.env.DEMO_PASSWORD || 'HryukersDemo2026!')
  await page.getByRole('button', { name: 'Войти в платформу' }).click()
  await expect(page.getByRole('heading', { name: 'Обзор платформы' })).toBeVisible()
  await page.getByRole('link', { name: 'Источники данных', exact: true }).click()
  await expect(page).toHaveURL(/#\/sources$/)
  await page.getByRole('button', { name: 'Подключение к серверу' }).click()
  await expect(page.getByLabel('Адрес сервера')).toHaveValue('http://127.0.0.1:5181/')
  await page.getByLabel('Адрес сервера').fill('http://localhost:59999')
  await page.getByRole('button', { name: 'Проверить и подключить' }).click()
  await expect(page.getByRole('alert')).toContainText('Сервер недоступен')
  await page.getByRole('button', { name: 'Отмена', exact: true }).click()
  await page.getByRole('button', { name: 'Выйти', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Войти в платформу' })).toBeVisible()
})

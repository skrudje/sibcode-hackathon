import { test, expect } from '@playwright/test'
import { mkdir } from 'node:fs/promises'

// Isolated IPC failure contracts; these do not certify a native window or a backend.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const state = window as unknown as {
      isTauri: boolean
      healthOnline: boolean
      authUnavailable: boolean
      __TAURI_INTERNALS__: { invoke: (command: string) => Promise<unknown> }
    }
    state.isTauri = true
    state.healthOnline = false
    state.authUnavailable = true
    state.__TAURI_INTERNALS__ = {
      invoke: async (command) => {
        if (command === 'desktop_connection') return { serverUrl: 'http://127.0.0.1:5181/', generation: 0 }
        if (command === 'desktop_check') {
          if (!state.healthOnline) throw 'Сервер недоступен. Проверьте адрес и подключение'
          return
        }
        if (command === 'desktop_connect') throw 'Сервер недоступен. Проверьте адрес и подключение'
        if (command === 'desktop_request') {
          if (state.authUnavailable) throw 'Сервер недоступен. Проверьте адрес и подключение'
          return { status: 401, headers: { 'content-type': 'application/json' }, bodyBase64: btoa(JSON.stringify({ error: { code: 'unauthorized', message: 'Sign in' } })) }
        }
        throw new Error(`Unexpected command: ${command}`)
      },
    }
  })
})

test('недоступный сервер → повторная попытка → доступен и нужен вход', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('status').filter({ hasText: 'Сервер недоступен' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Не удалось открыть платформу' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Войти в платформу' })).toHaveCount(0)
  await mkdir('../../.data/qa/desktop', { recursive: true })
  await page.screenshot({ path: '../../.data/qa/desktop/offline-ipc.png', fullPage: true })
  await page.evaluate(() => Object.assign(window, { healthOnline: true, authUnavailable: false }))
  await page.getByRole('button', { name: 'Повторить попытку', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Сервер доступен' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Войти в платформу' })).toBeVisible()
  await page.screenshot({ path: '../../.data/qa/desktop/online-ipc.png', fullPage: true })
})

test('неудачная смена адреса оставляет текущий сервер и допускает повтор', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Подключение к серверу', exact: true }).click()
  await page.getByLabel('Адрес сервера').fill('https://cdp.example.invalid')
  await page.getByRole('button', { name: 'Проверить и подключить', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Сервер недоступен')
  await expect(page.getByRole('button', { name: 'Проверить и подключить', exact: true })).toBeEnabled()
  await page.screenshot({ path: '../../.data/qa/desktop/connection-error-ipc.png', fullPage: true })
  await page.getByRole('button', { name: 'Отмена', exact: true }).click()
  await expect(page.getByText('http://127.0.0.1:5181/', { exact: true })).toBeVisible()
})

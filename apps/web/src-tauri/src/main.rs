#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;

use backend::{ApiRequest, ApiResponse, Backend};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, sync::Mutex};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

const DEFAULT_SERVER: &str = "http://127.0.0.1:5180";

struct Connection(Mutex<Backend>);

impl Connection {
    fn snapshot(&self) -> Result<Backend, String> {
        self.0.lock().map(|v| v.clone()).map_err(|_| "Подключение временно недоступно".into())
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionInfo {
    server_url: String,
}

#[tauri::command]
fn desktop_connection(state: State<'_, Connection>) -> Result<ConnectionInfo, String> {
    Ok(ConnectionInfo { server_url: state.snapshot()?.url.to_string() })
}

#[tauri::command]
async fn desktop_connect(app: tauri::AppHandle, state: State<'_, Connection>, server_url: String) -> Result<ConnectionInfo, String> {
    let backend = Backend::new(&server_url)?;
    backend.check().await?;
    let info = ConnectionInfo { server_url: backend.url.to_string() };
    let directory = app.path().app_config_dir().map_err(|_| "Не удалось найти папку настроек")?;
    fs::create_dir_all(&directory).map_err(|_| "Не удалось создать папку настроек")?;
    fs::write(directory.join("connection.json"), serde_json::to_vec(&info).map_err(|_| "Не удалось сохранить адрес")?)
        .map_err(|_| "Не удалось сохранить адрес сервера")?;
    *state.0.lock().map_err(|_| "Подключение временно недоступно")? = backend;
    Ok(info)
}

#[tauri::command]
async fn desktop_request(state: State<'_, Connection>, request: ApiRequest) -> Result<ApiResponse, String> {
    state.snapshot()?.request(request).await
}

#[tauri::command]
async fn desktop_save_export(app: tauri::AppHandle, state: State<'_, Connection>, export_id: String) -> Result<bool, String> {
    let id = uuid::Uuid::parse_str(&export_id).map_err(|_| "Некорректный номер выгрузки")?;
    let response = state.snapshot()?.request(ApiRequest {
        path: format!("/api/v1/exports/{id}/download"), method: "GET".into(), headers: HashMap::new(), body_base64: None,
    }).await?;
    if response.status != 200 {
        return Err("Не удалось скачать выгрузку. Проверьте сессию и повторите запрос".into());
    }
    let bytes = STANDARD.decode(response.body_base64).map_err(|_| "Не удалось прочитать CSV")?;
    let destination = app.dialog().file().add_filter("CSV", &["csv"])
        .set_file_name(format!("hryukers-{id}.csv")).blocking_save_file();
    if let Some(path) = destination {
        let path = path.into_path().map_err(|_| "Выберите локальный файл")?;
        fs::write(path, bytes).map_err(|_| "Не удалось сохранить CSV. Проверьте доступ к папке")?;
        return Ok(true);
    }
    Ok(false)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let saved = app.path().app_config_dir().ok()
                .and_then(|p| fs::read(p.join("connection.json")).ok())
                .and_then(|bytes| serde_json::from_slice::<ConnectionInfo>(&bytes).ok())
                .and_then(|info| Backend::new(&info.server_url).ok());
            app.manage(Connection(Mutex::new(saved.unwrap_or(Backend::new(DEFAULT_SERVER)?))));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![desktop_connection, desktop_connect, desktop_request, desktop_save_export])
        .run(tauri::generate_context!())
        .expect("Не удалось запустить Хрюкерсы CDP");
}

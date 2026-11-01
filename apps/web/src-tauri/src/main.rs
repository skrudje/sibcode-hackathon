#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;

use backend::{ApiRequest, ApiResponse, Backend};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, sync::Mutex};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

const DEFAULT_SERVER: &str = "http://127.0.0.1:5180";

struct ActiveConnection {
    backend: Backend,
    generation: u32,
}

struct Connection(Mutex<ActiveConnection>);

impl Connection {
    fn snapshot(&self) -> Result<ActiveConnection, String> {
        self.0
            .lock()
            .map(|v| ActiveConnection {
                backend: v.backend.clone(),
                generation: v.generation,
            })
            .map_err(|_| "Подключение временно недоступно".into())
    }

    fn require_generation(&self, generation: u32) -> Result<Backend, String> {
        let current = self.snapshot()?;
        if current.generation != generation {
            return Err("Сервер изменён. Войдите заново".into());
        }
        Ok(current.backend)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionInfo {
    server_url: String,
    #[serde(default)]
    generation: u32,
}

#[tauri::command]
fn desktop_connection(state: State<'_, Connection>) -> Result<ConnectionInfo, String> {
    let current = state.snapshot()?;
    Ok(ConnectionInfo {
        server_url: current.backend.url.to_string(),
        generation: current.generation,
    })
}

#[tauri::command]
async fn desktop_connect(
    app: tauri::AppHandle,
    state: State<'_, Connection>,
    server_url: String,
    generation: u32,
) -> Result<ConnectionInfo, String> {
    let current = state.require_generation(generation)?;
    let backend = Backend::new(&server_url)?;
    if backend.url == current.url {
        current.check().await?;
        state.require_generation(generation)?;
        return Ok(ConnectionInfo {
            server_url: current.url.to_string(),
            generation,
        });
    }
    backend.check().await?;
    let info = ConnectionInfo {
        server_url: backend.url.to_string(),
        generation: generation + 1,
    };
    let mut active = state
        .0
        .lock()
        .map_err(|_| "Подключение временно недоступно")?;
    if active.generation != generation {
        return Err("Сервер уже изменён. Повторите подключение".into());
    }
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|_| "Не удалось найти папку настроек")?;
    fs::create_dir_all(&directory).map_err(|_| "Не удалось создать папку настроек")?;
    fs::write(
        directory.join("connection.json"),
        serde_json::to_vec(&info).map_err(|_| "Не удалось сохранить адрес")?,
    )
    .map_err(|_| "Не удалось сохранить адрес сервера")?;
    *active = ActiveConnection {
        backend,
        generation: info.generation,
    };
    Ok(info)
}

#[tauri::command]
async fn desktop_request(
    state: State<'_, Connection>,
    request: ApiRequest,
    generation: u32,
) -> Result<ApiResponse, String> {
    let response = state
        .require_generation(generation)?
        .request(request)
        .await?;
    state.require_generation(generation)?;
    Ok(response)
}

#[tauri::command]
async fn desktop_check(state: State<'_, Connection>, generation: u32) -> Result<(), String> {
    state.require_generation(generation)?.check().await?;
    state.require_generation(generation)?;
    Ok(())
}

#[tauri::command]
async fn desktop_save_export(
    app: tauri::AppHandle,
    state: State<'_, Connection>,
    export_id: String,
    generation: u32,
) -> Result<bool, String> {
    let id = uuid::Uuid::parse_str(&export_id).map_err(|_| "Некорректный номер выгрузки")?;
    let response = state
        .require_generation(generation)?
        .request(ApiRequest {
            path: format!("/api/v1/exports/{id}/download"),
            method: "GET".into(),
            headers: HashMap::new(),
            body_base64: None,
        })
        .await?;
    if response.status != 200 {
        return Err("Не удалось скачать выгрузку. Проверьте сессию и повторите запрос".into());
    }
    let bytes = STANDARD
        .decode(response.body_base64)
        .map_err(|_| "Не удалось прочитать CSV")?;
    state.require_generation(generation)?;
    let destination = app
        .dialog()
        .file()
        .add_filter("CSV", &["csv"])
        .set_file_name(format!("hryukers-{id}.csv"))
        .blocking_save_file();
    if let Some(path) = destination {
        state.require_generation(generation)?;
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
            let saved = app
                .path()
                .app_config_dir()
                .ok()
                .and_then(|p| fs::read(p.join("connection.json")).ok())
                .and_then(|bytes| serde_json::from_slice::<ConnectionInfo>(&bytes).ok())
                .and_then(|info| Backend::new(&info.server_url).ok());
            app.manage(Connection(Mutex::new(ActiveConnection {
                backend: saved.unwrap_or(Backend::new(DEFAULT_SERVER)?),
                generation: 0,
            })));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_connection,
            desktop_check,
            desktop_connect,
            desktop_request,
            desktop_save_export
        ])
        .run(tauri::generate_context!())
        .expect("Не удалось запустить Хрюкерсы CDP");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn glib_string_variant_iterators_use_a_valid_out_pointer() {
        use glib::variant::ToVariant;
        let value = ["first", "second", "third"].to_variant();
        assert_eq!(
            value.array_iter_str().unwrap().collect::<Vec<_>>(),
            ["first", "second", "third"]
        );
        assert_eq!(
            value.array_iter_str().unwrap().rev().collect::<Vec<_>>(),
            ["third", "second", "first"]
        );
        assert_eq!(value.array_iter_str().unwrap().nth(1), Some("second"));
        assert_eq!(value.array_iter_str().unwrap().nth_back(1), Some("second"));
        assert_eq!(value.array_iter_str().unwrap().last(), Some("third"));
    }

    #[test]
    fn replacing_connection_rejects_old_webview_requests() {
        let connection = Connection(Mutex::new(ActiveConnection {
            backend: Backend::new(DEFAULT_SERVER).unwrap(),
            generation: 0,
        }));
        assert!(connection.require_generation(0).is_ok());
        *connection.0.lock().unwrap() = ActiveConnection {
            backend: Backend::new("http://localhost:5181").unwrap(),
            generation: 1,
        };
        assert!(connection.require_generation(0).is_err());
        assert_eq!(
            connection.require_generation(1).unwrap().url.port(),
            Some(5181)
        );
    }
}

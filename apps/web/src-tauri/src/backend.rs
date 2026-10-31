use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{redirect::Policy, Client, Method};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, time::Duration};
use url::Url;

pub const MAX_RESPONSE: usize = 25 * 1024 * 1024;
const MAX_REQUEST: usize = 12 * 1024 * 1024;

#[derive(Clone)]
pub struct Backend {
    pub url: Url,
    pub client: Client,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiRequest {
    pub path: String,
    pub method: String,
    pub headers: HashMap<String, String>,
    pub body_base64: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body_base64: String,
}

pub fn validate_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value.trim()).map_err(|_| "Введите полный адрес сервера")?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        return Err(
            "Для удалённого сервера нужен HTTPS. HTTP разрешён только для localhost".into(),
        );
    }
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("Укажите адрес сервера без пароля, пути, параметров и фрагмента".into());
    }
    Ok(url)
}

impl Backend {
    pub fn new(value: &str) -> Result<Self, String> {
        Ok(Self {
            url: validate_url(value)?,
            client: Client::builder()
                .cookie_store(true)
                .redirect(Policy::none())
                .connect_timeout(Duration::from_secs(8))
                .timeout(Duration::from_secs(60))
                .build()
                .map_err(|_| "Не удалось создать подключение")?,
        })
    }

    pub fn api_url(&self, path: &str) -> Result<Url, String> {
        let raw_path = path.split('?').next().unwrap_or("");
        if !raw_path.starts_with("/api/v1/")
            || raw_path.contains('%')
            || raw_path.contains('\\')
            || raw_path.split('/').any(|p| p == "." || p == "..")
            || path.contains('#')
            || path.chars().any(char::is_control)
        {
            return Err("Разрешены только относительные запросы API платформы".into());
        }
        let url = self.url.join(path).map_err(|_| "Некорректный API-запрос")?;
        if url.origin() != self.url.origin() || !url.path().starts_with("/api/v1/") {
            return Err("Адрес запроса не относится к серверу платформы".into());
        }
        Ok(url)
    }

    pub async fn request(&self, input: ApiRequest) -> Result<ApiResponse, String> {
        let url = self.api_url(&input.path)?;
        if !matches!(
            input.method.as_str(),
            "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
        ) {
            return Err("Метод запроса не поддерживается".into());
        }
        let method =
            Method::from_bytes(input.method.as_bytes()).map_err(|_| "Некорректный метод")?;
        let mut request = self
            .client
            .request(method, url)
            .header("Origin", self.url.origin().ascii_serialization());
        for (key, value) in input.headers {
            if matches!(
                key.to_ascii_lowercase().as_str(),
                "content-type" | "idempotency-key"
            ) {
                request = request.header(key, value);
            }
        }
        if let Some(body) = input.body_base64 {
            if body.len() > MAX_REQUEST * 4 / 3 + 4 {
                return Err("Файл превышает допустимый размер".into());
            }
            let bytes = STANDARD
                .decode(body)
                .map_err(|_| "Не удалось прочитать данные запроса")?;
            if bytes.len() > MAX_REQUEST {
                return Err("Файл превышает допустимый размер".into());
            }
            request = request.body(bytes);
        }
        let mut response = request
            .send()
            .await
            .map_err(|_| "Сервер недоступен. Проверьте адрес и подключение")?;
        if response.status().is_redirection() {
            return Err("Сервер вернул перенаправление. Укажите конечный адрес сервера".into());
        }
        let status = response.status().as_u16();
        let headers = ["content-type", "content-disposition", "x-request-id"]
            .into_iter()
            .filter_map(|key| {
                response
                    .headers()
                    .get(key)
                    .and_then(|v| v.to_str().ok())
                    .map(|v| (key.to_string(), v.to_string()))
            })
            .collect();
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Соединение прервано при получении данных")?
        {
            if bytes.len() + chunk.len() > MAX_RESPONSE {
                return Err("Ответ сервера превышает допустимый размер".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(ApiResponse {
            status,
            headers,
            body_base64: STANDARD.encode(bytes),
        })
    }

    pub async fn check(&self) -> Result<(), String> {
        let response = self
            .request(ApiRequest {
                path: "/api/v1/health/ready".into(),
                method: "GET".into(),
                headers: HashMap::new(),
                body_base64: None,
            })
            .await?;
        let bytes = STANDARD
            .decode(response.body_base64)
            .map_err(|_| "Некорректный ответ сервера")?;
        let value: serde_json::Value = serde_json::from_slice(&bytes)
            .map_err(|_| "По этому адресу не найден API платформы")?;
        if response.status != 200 || value.get("status").and_then(|s| s.as_str()) != Some("ok") {
            return Err("Сервер пока не готов. Проверьте базу данных и очередь".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_server_requires_https_and_clean_origin() {
        for url in [
            "http://example.com",
            "https://user:secret@example.com",
            "https://example.com/api",
            "https://example.com?token=x",
            "file:///tmp/x",
        ] {
            assert!(validate_url(url).is_err(), "{url}");
        }
        for url in [
            "http://localhost:5180",
            "http://127.0.0.1:5180/",
            "http://[::1]:5180",
            "https://cdp.example.com",
        ] {
            assert!(validate_url(url).is_ok(), "{url}");
        }
    }

    #[test]
    fn request_cannot_escape_api_or_origin() {
        let backend = Backend::new("http://127.0.0.1:5180").unwrap();
        for path in [
            "https://evil.invalid/api/v1/x",
            "//evil.invalid/api/v1/x",
            "/api/v1/../../x",
            "/api/v1/%2e%2e/x",
            "/api/v1/a\\x",
            "/api/v1/auth/me#fragment",
            "/other",
        ] {
            assert!(backend.api_url(path).is_err(), "{path}");
        }
        assert_eq!(
            backend
                .api_url("/api/v1/customers?q=a%40b.invalid")
                .unwrap()
                .host_str(),
            Some("127.0.0.1")
        );
    }

    #[tokio::test]
    async fn native_session_keeps_cookie_and_preserves_upload_bytes() {
        use std::{
            io::{Read, Write},
            net::TcpListener,
            thread,
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let expected_origin = origin.clone();
        let upload = b"--boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"test.csv\"\r\n\r\n\xef\xbb\xbfclient,event\r\n--boundary--\r\n";
        let expected_upload = upload.to_vec();
        let server = thread::spawn(move || {
            for index in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(10)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut buf = [0_u8; 4096];
                let (header_end, size) = loop {
                    let n = stream.read(&mut buf).unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&buf[..n]);
                    if let Some(pos) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                        let header = String::from_utf8_lossy(&bytes[..pos]).to_lowercase();
                        let size: usize = header
                            .lines()
                            .find_map(|line| line.strip_prefix("content-length: "))
                            .unwrap_or("0")
                            .parse()
                            .unwrap();
                        break (pos + 4, size);
                    }
                };
                while bytes.len() < header_end + size {
                    let n = stream.read(&mut buf).unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&buf[..n]);
                }
                let header = String::from_utf8_lossy(&bytes[..header_end]).to_lowercase();
                assert!(header.contains(&format!("origin: {expected_origin}")));
                assert!(!header.contains("x-untrusted:"));
                if index == 1 {
                    assert!(header.contains("cookie: hryukers_session=test-session"));
                    assert!(header.contains("content-type: multipart/form-data; boundary=boundary"));
                    assert_eq!(&bytes[header_end..header_end + size], expected_upload);
                }
                let cookie = if index == 0 {
                    "Set-Cookie: hryukers_session=test-session; HttpOnly; Path=/\r\n"
                } else {
                    ""
                };
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Type: application/json\r\nConnection: close\r\n{cookie}\r\n{{}}").unwrap();
            }
        });
        let backend = Backend::new(&origin).unwrap();
        let response = backend
            .request(ApiRequest {
                path: "/api/v1/auth/login".into(),
                method: "POST".into(),
                headers: HashMap::new(),
                body_base64: None,
            })
            .await
            .unwrap();
        assert!(!response.headers.contains_key("set-cookie"));
        let mut headers = HashMap::new();
        headers.insert(
            "Content-Type".into(),
            "multipart/form-data; boundary=boundary".into(),
        );
        headers.insert("X-Untrusted".into(), "should-be-dropped".into());
        let response = backend
            .request(ApiRequest {
                path: "/api/v1/sources/example/imports".into(),
                method: "POST".into(),
                headers,
                body_base64: Some(STANDARD.encode(upload)),
            })
            .await
            .unwrap();
        assert_eq!(response.status, 200);
        server.join().unwrap();
    }
}

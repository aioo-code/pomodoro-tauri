fn main() {
    println!("cargo:rerun-if-env-changed=POMODORO_BUILD_VERSION");
    tauri_build::build()
}

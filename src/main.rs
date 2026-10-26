mod app;
mod editor;
mod filetree;
mod highlight;
mod icons;
mod keymap;

use std::path::PathBuf;

use eframe::egui;

fn main() -> eframe::Result {
    let path = std::env::args_os().nth(1).map(PathBuf::from);
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("Wim")
            .with_app_id("wim")
            .with_inner_size([1000.0, 720.0])
            .with_min_inner_size([320.0, 200.0]),
        ..Default::default()
    };
    eframe::run_native(
        "Wim",
        options,
        Box::new(move |cc| Ok(Box::new(app::WimApp::new(cc, path)))),
    )
}

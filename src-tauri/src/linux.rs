use gtk::prelude::GtkSettingsExt;

/// WebKitGTK 2.54 uses GDK's font DPI as a page scale even when it is the
/// unset sentinel (-1). Supply a real value before the first WebView exists.
pub fn init_gtk() {
    gtk::init().expect("failed to initialize GTK");
    let Some(screen) = gtk::gdk::Screen::default() else {
        return;
    };
    let dpi = screen.resolution();
    if dpi.is_finite() && dpi > 0.0 {
        return;
    }

    let dpi = gtk::Settings::default()
        .map(|settings| settings.gtk_xft_dpi())
        .filter(|dpi| *dpi > 0)
        .map(|dpi| f64::from(dpi) / 1024.0)
        .unwrap_or(96.0);
    let scale = std::env::var("GDK_DPI_SCALE")
        .ok()
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|scale| scale.is_finite() && *scale > 0.0)
        .unwrap_or(1.0);
    screen.set_resolution(dpi * scale);
}

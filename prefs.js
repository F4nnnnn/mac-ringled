import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// Keep the GTK slider fully responsive. Persist its value only after the user
// pauses for a moment, instead of writing GSettings for every pointer event.
function addPercentScale(group, settings, key, title, subtitle, min, max, step, multiplier = 100) {
    const row = new Adw.ActionRow({
        title,
        subtitle,
    });

    const scale = Gtk.Scale.new_with_range(
        Gtk.Orientation.HORIZONTAL,
        min,
        max,
        step
    );
    scale.set_digits(0);
    scale.set_draw_value(true);
    scale.set_size_request(220, -1);
    scale.set_valign(Gtk.Align.CENTER);
    scale.set_value(settings.get_double(key) * multiplier);
    scale.set_format_value_func((_scale, value) => `${Math.round(value)}%`);

    let pendingValue = scale.get_value();
    let pendingSource = 0;

    const flushPending = () => {
        if (!pendingSource)
            return;

        GLib.Source.remove(pendingSource);
        pendingSource = 0;
        settings.set_double(key, pendingValue / multiplier);
    };

    scale.connect('value-changed', () => {
        pendingValue = scale.get_value();

        if (pendingSource)
            GLib.Source.remove(pendingSource);

        pendingSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 180, () => {
            pendingSource = 0;
            settings.set_double(key, pendingValue / multiplier);
            return GLib.SOURCE_REMOVE;
        });
    });

    row.add_suffix(scale);
    row.set_activatable_widget(scale);
    group.add(row);
    return flushPending;
}

export default class MacRinglightPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._ringlightSettings = settings;

        const pendingSliderCommits = [];
        window.connect('close-request', () => {
            for (const flush of pendingSliderCommits)
                flush();
            return false;
        });

        const page = new Adw.PreferencesPage({
            title: 'Ringlight',
            icon_name: 'display-brightness-symbolic',
        });
        window.add(page);

        const generalGroup = new Adw.PreferencesGroup({
            title: 'Umum',
            description: 'Atur tampilan bingkai. Saat aktif, ringlight berada di depan dock seperti macOS.',
        });
        page.add(generalGroup);

        const enabledRow = new Adw.SwitchRow({
            title: 'Aktifkan Ringlight',
            subtitle: 'Tampilkan atau sembunyikan bingkai bercahaya.',
        });
        generalGroup.add(enabledRow);
        settings.bind('enabled', enabledRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        const appearanceGroup = new Adw.PreferencesGroup({
            title: 'Bentuk dan Cahaya',
            description: 'Nilai ukuran mengikuti sisi pendek layar agar proporsinya tetap konsisten.',
        });
        page.add(appearanceGroup);

        const colorModes = ['white', 'warm', 'natural'];
        const colorLabels = ['White', 'Warm', 'Natural'];
        const colorRow = new Adw.ComboRow({
            title: 'Warna ringlight',
            subtitle: 'White: putih dingin · Warm: putih hangat · Natural: putih netral.',
            model: Gtk.StringList.new(colorLabels),
        });
        const currentColor = settings.get_string('color-mode');
        const currentIndex = colorModes.indexOf(currentColor);
        colorRow.set_selected(currentIndex >= 0 ? currentIndex : 0);
        colorRow.connect('notify::selected', () => {
            const selected = colorRow.get_selected();
            if (selected >= 0 && selected < colorModes.length)
                settings.set_string('color-mode', colorModes[selected]);
        });
        appearanceGroup.add(colorRow);

        pendingSliderCommits.push(addPercentScale(
            appearanceGroup, settings, 'intensity',
            'Intensitas cahaya', 'Kecerahan ringlight; rentang ditingkatkan hingga 150%.',
            35, 150, 1
        ));
        pendingSliderCommits.push(addPercentScale(
            appearanceGroup, settings, 'thickness',
            'Ketebalan bingkai', 'Lebar pita putih dibandingkan sisi pendek layar.',
            4, 12, 1
        ));
        pendingSliderCommits.push(addPercentScale(
            appearanceGroup, settings, 'glow',
            'Kekuatan glow', 'Besarnya cahaya lembut di sekitar bingkai.',
            0, 100, 1
        ));
        pendingSliderCommits.push(addPercentScale(
            appearanceGroup, settings, 'radius',
            'Radius sudut', 'Semakin besar nilainya, semakin membulat bentuk bingkai.',
            10, 25, 1
        ));
        pendingSliderCommits.push(addPercentScale(
            appearanceGroup, settings, 'top-inset',
            'Jarak dari panel atas', 'Menggeser sisi atas bingkai ke bawah agar panel GNOME tetap terlihat.',
            1, 8, 1
        ));
    }
}

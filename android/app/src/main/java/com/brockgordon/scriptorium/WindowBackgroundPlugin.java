package com.brockgordon.scriptorium;

import android.graphics.Color;
import android.view.View;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Paints the window behind the web view in the app's own background colour.
 *
 * It only shows where the web view doesn't reach: on WebViews older than 140,
 * Capacitor can't let the page draw under the status and navigation bars, so it
 * pads the web view off them and the bars sit on this colour. The page sets it
 * whenever the theme changes, so the bars match light and dark mode.
 */
@CapacitorPlugin(name = "WindowBackground")
public class WindowBackgroundPlugin extends Plugin {

    @PluginMethod
    public void set(PluginCall call) {
        String hex = call.getString("color");
        if (hex == null) {
            call.reject("color is required");
            return;
        }
        final int color;
        try {
            color = Color.parseColor(hex);
        } catch (IllegalArgumentException e) {
            call.reject("not a colour: " + hex);
            return;
        }
        getActivity().runOnUiThread(() -> {
            getActivity().getWindow().getDecorView().setBackgroundColor(color);
            View parent = (View) getBridge().getWebView().getParent();
            if (parent != null) parent.setBackgroundColor(color);
            call.resolve();
        });
    }
}

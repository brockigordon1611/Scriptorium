package com.brockgordon.scriptorium;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own plugins are registered before the bridge starts.
        registerPlugin(WindowBackgroundPlugin.class);
        super.onCreate(savedInstanceState);
    }
}

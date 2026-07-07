import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.surveytoolshub.app',
  appName: 'Survey Tools Hub',
  webDir: 'dist',
  // The Flutter app (GRX3 Field) already owns the ./android folder, so the
  // Capacitor Android project lives in ./android-app to avoid a collision.
  android: {
    path: 'android-app',
  },
};

export default config;

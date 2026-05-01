#import <Capacitor/Capacitor.h>

CAP_PLUGIN(QuickLookPlugin, "QuickLook",
  CAP_PLUGIN_METHOD(openPDF, CAPPluginReturnPromise);
)

#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

CAP_PLUGIN(DocViewerPlugin, "DocViewer",
  CAP_PLUGIN_METHOD(openFile, CAPPluginReturnPromise);
)

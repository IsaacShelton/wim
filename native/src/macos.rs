// Quit from the Dock (or logging out) asks Wim first, as the close button
// does. Tao's app delegate has no `applicationShouldTerminate:`, so Cocoa
// would end the app, and the editor with any unsaved work, straight away;
// this adds one. Tao itself quits with `exit`, not `terminate:`, so this
// doesn't stand in the way when Wim decides to quit.

use std::ffi::c_void;
use std::sync::OnceLock;

use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::{ffi, sel};

const NS_TERMINATE_CANCEL: usize = 0;
const NS_TERMINATE_NOW: usize = 1;

/// Asks the editor to quit; false if it isn't running.
static HANDLER: OnceLock<Box<dyn Fn() -> bool + Send + Sync>> = OnceLock::new();

/// Call `handler` when macOS asks the app to quit. While it returns true,
/// the app stays, and the editor decides.
pub fn on_quit(handler: impl Fn() -> bool + Send + Sync + 'static) {
    if HANDLER.set(Box::new(handler)).is_err() {
        return;
    }
    let Some(class) = AnyClass::get(c"TaoAppDelegateParent") else {
        eprintln!("wim: Quit from the Dock won't ask about unsaved changes");
        return;
    };
    type Method = extern "C-unwind" fn(&AnyObject, Sel, *mut c_void) -> usize;
    unsafe {
        // NSApplicationTerminateReply (NSUInteger) applicationShouldTerminate:(NSApplication *)
        ffi::class_addMethod(
            class as *const AnyClass as *mut AnyClass,
            sel!(applicationShouldTerminate:),
            std::mem::transmute::<Method, Imp>(should_terminate),
            c"Q@:@".as_ptr(),
        );
    }
}

extern "C-unwind" fn should_terminate(_: &AnyObject, _: Sel, _: *mut c_void) -> usize {
    match HANDLER.get() {
        Some(handler) if handler() => NS_TERMINATE_CANCEL,
        _ => NS_TERMINATE_NOW,
    }
}

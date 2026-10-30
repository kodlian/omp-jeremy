// Runs the Swift entry point when DYLD_INSERT_LIBRARIES loads the dylib.
extern void sim_preview_loader_start(void);

__attribute__((constructor)) static void sim_preview_loader_constructor(void) {
    sim_preview_loader_start();
}

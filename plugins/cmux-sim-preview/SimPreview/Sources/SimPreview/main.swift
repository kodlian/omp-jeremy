import Foundation

setvbuf(stdout, nil, _IOLBF, 0)
signal(SIGPIPE, SIG_IGN)
signal(SIGINT, SIG_IGN)
let interruption = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
interruption.setEventHandler {
    unlink(LoaderLink.path(for: getpid()))
    exit(130)
}
interruption.resume()

do {
    let options = try Options(arguments: Array(CommandLine.arguments.dropFirst()))
    try await PreviewSession(options: options).run()
} catch {
    print(error)
    exit(1)
}

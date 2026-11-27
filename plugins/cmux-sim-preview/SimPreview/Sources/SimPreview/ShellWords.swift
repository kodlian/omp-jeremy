/// Splits a command line the way a POSIX shell does: whitespace separates words, quotes and backslashes escape.
enum ShellWords {
    static func split(_ line: Substring) -> [String] {
        var words: [String] = []
        var current = ""
        var inWord = false
        var quote: Character?
        var escaped = false
        for character in line {
            if escaped {
                current.append(character)
                escaped = false
            } else if let open = quote {
                if character == open {
                    quote = nil
                } else if character == "\\", open == "\"" {
                    escaped = true
                } else {
                    current.append(character)
                }
            } else if character == "\\" {
                escaped = true
                inWord = true
            } else if character == "\"" || character == "'" {
                quote = character
                inWord = true
            } else if character == " " || character == "\t" {
                if inWord {
                    words.append(current)
                    current = ""
                    inWord = false
                }
            } else {
                current.append(character)
                inWord = true
            }
        }
        if inWord {
            words.append(current)
        }
        return words
    }
}

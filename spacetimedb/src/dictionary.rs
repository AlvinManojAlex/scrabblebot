// Embedded wordlist — sorted, uppercase, one word per line.
// Replace `wordlist.txt` with a real Scrabble dictionary (TWL or SOWPODS) for serious play.
static WORDLIST: &str = include_str!("../wordlist.txt");

pub fn is_valid_word(word: &str) -> bool {
    let target = word.to_ascii_uppercase();
    if target.len() < 2 {
        return false;
    }
    if !target.chars().all(|c| c.is_ascii_uppercase()) {
        return false;
    }
    // Binary search over sorted lines.
    let lines: Vec<&str> = WORDLIST.lines().collect();
    lines.binary_search(&target.as_str()).is_ok()
}

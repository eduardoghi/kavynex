//! Classifies an IP address as safe or unsafe to fetch from a user-provided URL (the SSRF guard
//! behind the thumbnail/avatar downloader in `services::thumbnail_download`). Kept in its own
//! module - pure, dependency-free, no network or filesystem - so the whole classifier can sit under
//! the mutation gate (`.cargo/mutants.toml`) without dragging in the downloader's untestable async
//! network code. `is_disallowed_ip` is the only entry point the downloader uses; it is applied both
//! as a pre-connection check and inside the pinned DNS resolver, so the address that is validated is
//! the address that is dialed.
//!
//! The tunnel-embedded-IPv4 decoders (6to4/NAT64/Teredo) are separate functions purely so their bit
//! arithmetic can be pinned by exact-value tests: a classification-only test misses a swapped
//! shift/mask/XOR whenever the wrong octet still lands in the same allow/deny band, which is exactly
//! how those operator mutations survived before this split.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

fn is_disallowed_ipv4(addr: &Ipv4Addr) -> bool {
    let octets = addr.octets();

    addr.is_loopback()
        || addr.is_private()
        || addr.is_link_local()
        || addr.is_broadcast()
        || addr.is_documentation()
        || addr.is_multicast()
        || addr.is_unspecified()
        || octets[0] == 0 // 0.0.0.0/8 "this host on this network"
        || (octets[0] == 100 && (64..=127).contains(&octets[1])) // 100.64.0.0/10 CGNAT
        || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0) // 192.0.0.0/24 IETF protocol assignments
        || (octets[0] == 198 && (octets[1] == 18 || octets[1] == 19)) // 198.18.0.0/15 benchmarking
        || octets[0] >= 240 // 240.0.0.0/4 reserved
}

/// Extracts the IPv4 address a 6to4 address (2002::/16) embeds in bits 16..48 (segments 1 and 2).
fn embedded_6to4_ipv4(segments: &[u16; 8]) -> Ipv4Addr {
    Ipv4Addr::new(
        (segments[1] >> 8) as u8,
        (segments[1] & 0xff) as u8,
        (segments[2] >> 8) as u8,
        (segments[2] & 0xff) as u8,
    )
}

/// Extracts the IPv4 address a NAT64 address (64:ff9b::/96) embeds in its low 32 bits (segments 6
/// and 7).
fn embedded_nat64_ipv4(segments: &[u16; 8]) -> Ipv4Addr {
    Ipv4Addr::new(
        (segments[6] >> 8) as u8,
        (segments[6] & 0xff) as u8,
        (segments[7] >> 8) as u8,
        (segments[7] & 0xff) as u8,
    )
}

/// Extracts the IPv4 address a Teredo address (2001:0000::/32) tunnels in its low 32 bits (segments
/// 6 and 7), XOR-obfuscated with all-ones.
fn embedded_teredo_ipv4(segments: &[u16; 8]) -> Ipv4Addr {
    Ipv4Addr::new(
        ((segments[6] >> 8) as u8) ^ 0xff,
        ((segments[6] & 0xff) as u8) ^ 0xff,
        ((segments[7] >> 8) as u8) ^ 0xff,
        ((segments[7] & 0xff) as u8) ^ 0xff,
    )
}

fn is_disallowed_ipv6(addr: &Ipv6Addr) -> bool {
    if let Some(mapped) = addr.to_ipv4_mapped() {
        return is_disallowed_ipv4(&mapped);
    }

    // The deprecated IPv4-compatible form (::a.b.c.d, without the ffff of a mapped address) embeds
    // an IPv4 address in the low 32 bits of ::/96. to_ipv4() returns it (and returns None for a
    // real global IPv6), so ::7f00:1 (= ::127.0.0.1) is judged by the same IPv4 rules rather than
    // slipping through as "some public v6". This also subsumes IPv6 loopback (::1) and unspecified
    // (::): both sit in ::/96, so to_ipv4() returns them here and is_disallowed_ipv4 rejects them -
    // which is why the final classification below does not test is_loopback()/is_unspecified()
    // again (doing so would only add an unkillable equivalent branch).
    if let Some(compatible) = addr.to_ipv4() {
        if is_disallowed_ipv4(&compatible) {
            return true;
        }
    }

    let segments = addr.segments();

    // 6to4 (2002::/16) embeds an IPv4 in bits 16..48 (segments 1 and 2); NAT64 (64:ff9b::/96)
    // embeds it in the low 32 bits (segments 6 and 7). Neither is decoded by
    // to_ipv4()/to_ipv4_mapped above, so a AAAA record in one of these forms could smuggle a
    // private/loopback IPv4 past the checks. Extract the embedded address and re-check it by the
    // same IPv4 rules; a genuinely public embedded address is left allowed.
    if segments[0] == 0x2002 {
        let embedded = embedded_6to4_ipv4(&segments);

        if is_disallowed_ipv4(&embedded) {
            return true;
        }
    }

    if segments[..6] == [0x0064, 0xff9b, 0, 0, 0, 0] {
        let embedded = embedded_nat64_ipv4(&segments);

        if is_disallowed_ipv4(&embedded) {
            return true;
        }
    }

    // Teredo (2001:0000::/32) tunnels IPv4 through IPv6: the peer IPv4 sits XOR-obfuscated (with
    // all-ones) in the low 32 bits (segments 6 and 7). Recover and re-check it by the same IPv4
    // rules, matching the 6to4/NAT64 handling above, so a Teredo AAAA cannot smuggle a
    // private/loopback IPv4 past the guard on a host with a Teredo tunnel active.
    if segments[0] == 0x2001 && segments[1] == 0x0000 {
        let embedded = embedded_teredo_ipv4(&segments);

        if is_disallowed_ipv4(&embedded) {
            return true;
        }
    }

    let first_segment = segments[0];

    addr.is_multicast()
        || (first_segment & 0xfe00) == 0xfc00 // fc00::/7 unique local
        || (first_segment & 0xffc0) == 0xfe80 // fe80::/10 link local
}

/// Rejects addresses that must never be fetched from a user-provided URL: loopback, private,
/// link-local (incl. cloud metadata 169.254.169.254), multicast and reserved - including the same
/// ranges reached through an IPv4-mapped, IPv4-compatible, 6to4, NAT64 or Teredo IPv6 address.
pub(crate) fn is_disallowed_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(addr) => is_disallowed_ipv4(addr),
        IpAddr::V6(addr) => is_disallowed_ipv6(addr),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn embedded_tunnel_decoders_extract_every_octet() {
        // A source address whose four octets are all distinct and non-trivial (0x12.0x34.0x56.0x78),
        // so any swapped shift or mask - and, for Teredo, a swapped XOR - changes the decoded
        // address and fails an exact-equality assertion. A classification-only test would miss these:
        // many octet values map to the same allow/deny verdict (e.g. any 127.x is loopback), which is
        // exactly why the operator mutations here survived until this decode was pinned by value.
        let target = Ipv4Addr::new(0x12, 0x34, 0x56, 0x78);

        // 6to4 carries the address in the clear in segments 1 and 2.
        let sixtofour = [0x2002, 0x1234, 0x5678, 0, 0, 0, 0, 0];
        assert_eq!(embedded_6to4_ipv4(&sixtofour), target);

        // NAT64 carries it in the clear in segments 6 and 7.
        let nat64 = [0x0064, 0xff9b, 0, 0, 0, 0, 0x1234, 0x5678];
        assert_eq!(embedded_nat64_ipv4(&nat64), target);

        // Teredo carries it in segments 6 and 7, XOR-obfuscated with all-ones:
        // 0x12345678 ^ 0xffffffff = 0xedcba987.
        let teredo = [0x2001, 0x0000, 0, 0, 0, 0, 0xedcb, 0xa987];
        assert_eq!(embedded_teredo_ipv4(&teredo), target);
    }

    #[test]
    fn is_disallowed_ip_blocks_private_and_reserved_ranges() {
        for blocked in [
            "127.0.0.1",        // loopback
            "10.1.2.3",         // private
            "172.16.5.4",       // private
            "192.168.0.10",     // private
            "169.254.169.254",  // link-local / cloud metadata
            "100.64.0.1",       // CGNAT
            "0.0.0.0",          // unspecified
            "240.0.0.1",        // reserved
            "224.0.0.1",        // multicast
            "192.0.0.1",        // 192.0.0.0/24 IETF protocol assignments
            "198.18.0.1",       // 198.18.0.0/15 benchmarking
            "198.19.255.255",   // 198.18.0.0/15 benchmarking (upper half)
            "192.0.2.1",        // 192.0.2.0/24 documentation (is_documentation)
            "0.1.2.3",          // 0.0.0.0/8 but not the unspecified address itself
            "ff02::1",          // ipv6 multicast (not caught by the mapped/compatible branches)
            "::1",              // ipv6 loopback
            "fe80::1",          // ipv6 link local
            "fc00::1",          // ipv6 unique local
            "::ffff:127.0.0.1", // ipv4-mapped loopback
            "::7f00:1",         // deprecated ipv4-compatible form of 127.0.0.1
            "::a01:203",        // deprecated ipv4-compatible form of 10.1.2.3 (private)
            "2002:7f00:0001::", // 6to4 wrapping 127.0.0.1 (loopback)
            "2002:c0a8:0001::", // 6to4 wrapping 192.168.0.1 (private)
            // 6to4/nat64/teredo wrapping 172.16.5.4, whose second octet (16) is what places it in
            // 172.16.0.0/12: pins the embedded-address byte extraction, since corrupting that octet
            // (e.g. masking it to 255) would push the embedded IP out of the private range and let
            // the tunnelled address through.
            "2002:ac10:0504::",         // 6to4 wrapping 172.16.5.4 (private)
            "64:ff9b::ac10:0504",       // nat64 wrapping 172.16.5.4 (private)
            "2001:0:0:0:0:0:53ef:fafb", // teredo wrapping 172.16.5.4: 53ef:fafb = 0xac100504 ^ all-ones
            "64:ff9b::7f00:1",          // nat64 wrapping 127.0.0.1 (loopback)
            "64:ff9b::a01:203",         // nat64 wrapping 10.1.2.3 (private)
            // teredo (2001:0000::/32) with the client IPv4 XOR-obfuscated in the low 32 bits:
            // 80ff:fffe = 0x80fffffe = 0x7f000001 ^ 0xffffffff = 127.0.0.1 (loopback).
            "2001:0:0:0:0:0:80ff:fffe",
            // c0a8:0001 xored: 3f57:fffe = 0x3f57fffe ^ 0xffffffff = 0xc0a80001 = 192.168.0.1.
            "2001:0:0:0:0:0:3f57:fffe",
        ] {
            assert!(
                is_disallowed_ip(&ip(blocked)),
                "{blocked} should be blocked"
            );
        }
    }

    #[test]
    fn is_disallowed_ip_allows_public_addresses() {
        for allowed in [
            "8.8.8.8",
            "1.1.1.1",
            "142.250.72.238",
            // Public addresses that sit just outside a named range, so each range check has to
            // require its full condition rather than a single octet. These pin the AND/OR structure
            // of is_disallowed_ipv4 (a weakened `&&`/`||` would misclassify one of them):
            "8.100.0.1", // second octet in the CGNAT 64..=127 window but first octet is not 100
            "100.0.0.1", // first octet 100 but second octet outside the CGNAT window
            "192.0.1.1", // starts 192.0 but third octet is not 0, so not 192.0.0.0/24
            "192.1.0.1", // 192 but second octet is not 0, so not 192.0.0.0/24
            "8.18.0.1",  // second octet 18 but first octet is not 198, so not benchmarking
            "198.0.0.1", // first octet 198 but second octet is neither 18 nor 19
            "2606:4700:4700::1111",
            "2002:0808:0808::",   // 6to4 wrapping the public 8.8.8.8 stays allowed
            "64:ff9b::0808:0808", // nat64 wrapping the public 8.8.8.8 stays allowed
            // A public, non-Teredo 2001: address: the Teredo prefix is 2001:0000::/32, so this must
            // not be decoded as Teredo. Pins the `segments[0] == 0x2001 && segments[1] == 0x0000`
            // conjunction - a weakened `&&` would treat it as Teredo and re-check a bogus embedded IP.
            "2001:4860:4860::8888",
            // teredo wrapping the public 8.8.8.8 stays allowed: f7f7:f7f7 = 0x08080808 ^ all-ones.
            "2001:0:0:0:0:0:f7f7:f7f7",
        ] {
            assert!(
                !is_disallowed_ip(&ip(allowed)),
                "{allowed} should be allowed"
            );
        }
    }
}

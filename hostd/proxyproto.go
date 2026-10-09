package main

import (
	"encoding/binary"
	"errors"
	"net/netip"
)

// PROXY protocol v2 (haproxy.org/download/2.9/doc/proxy-protocol.txt §2.2):
// a binary header written by the gateway before relaying the client's bytes,
// so SFTPGo (common.proxy_protocol) sees the real client address — needed
// for its logs and for the panel's bans (the auth hook reports that address).

// proxyV2Signature is the fixed 12-byte signature.
var proxyV2Signature = []byte{0x0D, 0x0A, 0x0D, 0x0A, 0x00, 0x0D, 0x0A, 0x51, 0x55, 0x49, 0x54, 0x0A}

const (
	proxyV2VersionProxy = 0x21 // version 2, command PROXY
	proxyV2TCP4         = 0x11 // AF_INET, STREAM
	proxyV2TCP6         = 0x21 // AF_INET6, STREAM
)

// encodeProxyV2 builds the header for a TCP connection src → dst. Mixed
// families are sent as IPv6 (IPv4-mapped).
func encodeProxyV2(src, dst netip.AddrPort) ([]byte, error) {
	if !src.IsValid() || !dst.IsValid() {
		return nil, errors.New("proxy v2: invalid address")
	}
	sa, da := src.Addr().Unmap(), dst.Addr().Unmap()
	fam := byte(proxyV2TCP4)
	if !sa.Is4() || !da.Is4() {
		fam = proxyV2TCP6
		sa, da = netip.AddrFrom16(sa.As16()), netip.AddrFrom16(da.As16())
	}
	var addrs []byte
	if fam == proxyV2TCP4 {
		s4, d4 := sa.As4(), da.As4()
		addrs = append(append(addrs, s4[:]...), d4[:]...)
	} else {
		s16, d16 := sa.As16(), da.As16()
		addrs = append(append(addrs, s16[:]...), d16[:]...)
	}
	addrs = binary.BigEndian.AppendUint16(addrs, src.Port())
	addrs = binary.BigEndian.AppendUint16(addrs, dst.Port())

	out := make([]byte, 0, 16+len(addrs))
	out = append(out, proxyV2Signature...)
	out = append(out, proxyV2VersionProxy, fam)
	out = binary.BigEndian.AppendUint16(out, uint16(len(addrs)))
	return append(out, addrs...), nil
}

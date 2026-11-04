package release

import (
	"encoding/binary"
	"errors"
)

var errSnappy = errors.New("not snappy's block format")

// snappy decodes Snappy's block format, as GitHub compacts the attestation bundles behind bundle_url: the length as a varint, then literals and copies. What it decodes is only read as a bundle, which the attestation check then holds or refuses.
func snappy(src []byte) ([]byte, error) {
	length, read := binary.Uvarint(src)
	if read <= 0 || length > maxAnswer {
		return nil, errSnappy
	}
	src = src[read:]
	dst := make([]byte, 0, length)
	for len(src) > 0 {
		tag := src[0]
		var size, offset int
		switch tag & 0x03 {
		case 0x00:
			size = int(tag >> 2)
			header := 1
			if size >= 60 {
				extra := size - 59
				if len(src) < 1+extra {
					return nil, errSnappy
				}
				size = 0
				for index := extra; index >= 1; index-- {
					size = size<<8 | int(src[index])
				}
				header += extra
			}
			size++
			if len(src) < header+size {
				return nil, errSnappy
			}
			dst = append(dst, src[header:header+size]...)
			src = src[header+size:]
			continue
		case 0x01:
			if len(src) < 2 {
				return nil, errSnappy
			}
			size = 4 + int(tag>>2&0x07)
			offset = int(tag&0xe0)<<3 | int(src[1])
			src = src[2:]
		case 0x02:
			if len(src) < 3 {
				return nil, errSnappy
			}
			size = 1 + int(tag>>2)
			offset = int(binary.LittleEndian.Uint16(src[1:3]))
			src = src[3:]
		default:
			if len(src) < 5 {
				return nil, errSnappy
			}
			size = 1 + int(tag>>2)
			offset = int(binary.LittleEndian.Uint32(src[1:5]))
			src = src[5:]
		}
		if offset <= 0 || offset > len(dst) || uint64(len(dst)+size) > length {
			return nil, errSnappy
		}
		// A copy may overlap what it writes, so it goes byte by byte.
		start := len(dst) - offset
		for index := 0; index < size; index++ {
			dst = append(dst, dst[start+index])
		}
	}
	if uint64(len(dst)) != length {
		return nil, errSnappy
	}
	return dst, nil
}

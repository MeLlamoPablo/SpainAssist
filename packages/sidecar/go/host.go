package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"
)

// desktop is the app on the other end of stdin/stdout (a fake in tests).
type desktop interface {
	// call asks the app and waits for its reply, or for ctx to end.
	call(ctx context.Context, m outMessage) (inMessage, error)
	send(m outMessage)
}

// host speaks the JSON-lines protocol (protocol.go) with the desktop app.
type host struct {
	outMu sync.Mutex
	out   *json.Encoder

	mu      sync.Mutex
	nextID  int64
	pending map[int64]chan inMessage
}

func newHost(w io.Writer) *host {
	return &host{out: json.NewEncoder(w), pending: map[int64]chan inMessage{}}
}

func (h *host) send(m outMessage) {
	h.outMu.Lock()
	defer h.outMu.Unlock()
	// A failed write means the app is gone: stdin closes next and the process exits.
	_ = h.out.Encode(m)
}

func (h *host) call(ctx context.Context, m outMessage) (inMessage, error) {
	ch := make(chan inMessage, 1)
	h.mu.Lock()
	h.nextID++
	id := h.nextID
	h.pending[id] = ch
	h.mu.Unlock()

	m.Type = "call"
	m.ID = id
	h.send(m)
	select {
	case reply := <-ch:
		return reply, nil
	case <-ctx.Done():
		h.mu.Lock()
		delete(h.pending, id)
		h.mu.Unlock()
		h.send(outMessage{Type: "cancel", ID: id})
		return inMessage{}, ctx.Err()
	}
}

// reply delivers the app's answer to a call (unknown or late answers are dropped).
func (h *host) reply(m inMessage) {
	h.mu.Lock()
	ch := h.pending[m.ID]
	delete(h.pending, m.ID)
	h.mu.Unlock()
	if ch != nil {
		ch <- m
	}
}

func (h *host) log(level, message string) {
	h.send(outMessage{Type: "log", Level: level, Message: message})
}

const maxLine = 4 << 20

var errLineTooLong = errors.New("message too long")

// readMessage reads one JSON line.
func readMessage(r *bufio.Reader) (inMessage, error) {
	var line []byte
	for {
		chunk, isPrefix, err := r.ReadLine()
		if err != nil {
			return inMessage{}, err
		}
		line = append(line, chunk...)
		if len(line) > maxLine {
			return inMessage{}, errLineTooLong
		}
		if !isPrefix {
			break
		}
	}
	var m inMessage
	err := json.Unmarshal(line, &m)
	return m, err
}

package main

import (
	"net/http"
	"strconv"
)

// Web file explorer of an account (files.go; contract:
// server/src/services/hostd/files.ts). Paths are relative to the account
// directory and always under staging/ or data/.

func registerFiles(mux *http.ServeMux, a *api) {
	const base = "/v1/accounts/{id}/files"
	mux.HandleFunc("GET "+base, a.listFiles)
	mux.HandleFunc("GET "+base+"/content", a.fileContent)
	mux.HandleFunc("POST "+base+"/mkdir", a.mkdirFile)
	mux.HandleFunc("POST "+base+"/delete", a.deleteFile)
	mux.HandleFunc("POST "+base+"/move", a.moveFile)
	mux.HandleFunc("POST "+base+"/copy", a.copyFile)
	mux.HandleFunc("POST "+base+"/uploads/{uid}", a.uploadBegin)
	mux.HandleFunc("PUT "+base+"/uploads/{uid}", a.uploadChunk)
	mux.HandleFunc("POST "+base+"/uploads/{uid}/commit", a.uploadCommit)
	mux.HandleFunc("DELETE "+base+"/uploads/{uid}", a.uploadAbort)
	mux.HandleFunc("POST "+base+"/extract", a.extractArchive)
	mux.HandleFunc("GET "+base+"/zip", a.zipFiles)
}

type filesBody struct {
	ownerBody
	Path      string `json:"path"`
	From      string `json:"from"`
	To        string `json:"to"`
	Size      *int64 `json:"size"`
	Overwrite bool   `json:"overwrite"`
}

// filesRequest decodes the body: account id, owner and the validated paths
// named in `paths` ("path", "from", "to").
func filesRequest(r *http.Request, paths ...string) (int64, Owner, filesBody, map[string][]string, error) {
	var body filesBody
	accountID, err := pathID(r, "id")
	if err == nil {
		err = decode(r, &body)
	}
	var o Owner
	if err == nil {
		o, err = body.owner()
	}
	segs := map[string][]string{}
	for _, name := range paths {
		if err != nil {
			break
		}
		raw := map[string]string{"path": body.Path, "from": body.From, "to": body.To}[name]
		segs[name], err = splitFilesPath(raw)
	}
	return accountID, o, body, segs, err
}

func (a *api) listFiles(w http.ResponseWriter, r *http.Request) {
	accountID, err := pathID(r, "id")
	var segs []string
	if err == nil {
		segs, err = splitFilesPath(r.URL.Query().Get("path"))
	}
	if err != nil {
		writeError(w, err)
		return
	}
	res, err := a.files.List(r.Context(), accountID, segs)
	reply(w, r, res, err)
}

// fileContent streams a regular file (Range supported: previews, resumes).
func (a *api) fileContent(w http.ResponseWriter, r *http.Request) {
	accountID, err := pathID(r, "id")
	var segs []string
	if err == nil {
		segs, err = splitFilesPath(r.URL.Query().Get("path"))
	}
	if err != nil {
		writeError(w, err)
		return
	}
	f, fi, err := a.files.Open(accountID, segs)
	if err != nil {
		writeError(w, err)
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("X-Oblimint-Size", strconv.FormatInt(fi.Size(), 10))
	w.Header().Set("X-Oblimint-Mtime", strconv.FormatInt(fi.ModTime().UnixMilli(), 10))
	http.ServeContent(w, r, "", fi.ModTime(), f)
}

func (a *api) mkdirFile(w http.ResponseWriter, r *http.Request) {
	id, o, _, segs, err := filesRequest(r, "path")
	if err == nil {
		err = a.files.Mkdir(id, segs["path"], o)
	}
	reply(w, r, okBody, err)
}

func (a *api) deleteFile(w http.ResponseWriter, r *http.Request) {
	id, o, _, segs, err := filesRequest(r, "path")
	if err == nil {
		err = a.files.Delete(id, segs["path"], o)
	}
	reply(w, r, okBody, err)
}

func (a *api) moveFile(w http.ResponseWriter, r *http.Request) {
	id, o, body, segs, err := filesRequest(r, "from", "to")
	if err == nil {
		err = a.files.Move(id, segs["from"], segs["to"], o, body.Overwrite)
	}
	reply(w, r, okBody, err)
}

func (a *api) copyFile(w http.ResponseWriter, r *http.Request) {
	id, o, _, segs, err := filesRequest(r, "from", "to")
	if err == nil {
		err = a.files.Copy(r.Context(), id, segs["from"], segs["to"], o)
	}
	reply(w, r, okBody, err)
}

func (a *api) uploadBegin(w http.ResponseWriter, r *http.Request) {
	id, o, body, segs, err := filesRequest(r, "path")
	if err == nil && body.Size == nil {
		err = badRequest("size is required")
	}
	if err == nil {
		err = a.files.UploadBegin(id, segs["path"], o, r.PathValue("uid"), *body.Size, body.Overwrite)
	}
	reply(w, r, okBody, err)
}

// uploadChunk: raw body, ?path=&uid=&gid=&offset= ; Content-Length required.
func (a *api) uploadChunk(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	accountID, err := pathID(r, "id")
	var segs []string
	if err == nil {
		segs, err = splitFilesPath(q.Get("path"))
	}
	var o Owner
	if err == nil {
		uid, e1 := strconv.Atoi(q.Get("uid"))
		gid, e2 := strconv.Atoi(q.Get("gid"))
		if e1 != nil || e2 != nil {
			err = badRequest("uid and gid are required")
		} else {
			o = Owner{uid, gid}
			err = validateOwner(o)
		}
	}
	var offset int64
	if err == nil {
		offset, err = strconv.ParseInt(q.Get("offset"), 10, 64)
		if err != nil {
			err = badRequest("invalid offset")
		}
	}
	if err == nil && (r.ContentLength < 0 || r.ContentLength > maxChunkBytes) {
		err = badRequest("Content-Length is required (at most %d bytes)", maxChunkBytes)
	}
	if err != nil {
		writeError(w, err)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, r.ContentLength)
	err = a.files.UploadChunk(accountID, segs, o, r.PathValue("uid"), offset, r.ContentLength, r.Body)
	reply(w, r, okBody, err)
}

func (a *api) uploadCommit(w http.ResponseWriter, r *http.Request) {
	id, o, body, segs, err := filesRequest(r, "path")
	if err == nil && body.Size == nil {
		err = badRequest("size is required")
	}
	if err == nil {
		err = a.files.UploadCommit(id, segs["path"], o, r.PathValue("uid"), *body.Size, body.Overwrite)
	}
	reply(w, r, okBody, err)
}

func (a *api) uploadAbort(w http.ResponseWriter, r *http.Request) {
	id, o, _, segs, err := filesRequest(r, "path")
	if err == nil {
		err = a.files.UploadAbort(id, segs["path"], o, r.PathValue("uid"))
	}
	reply(w, r, okBody, err)
}

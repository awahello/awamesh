# awamesh 中继镜像：只装 derper，体积 ~30MB
# 用法：docker run -d --restart unless-stopped -p 18444:18444 -p 18444:18444/udp \
#         --entrypoint derper ghcr.io/awahello/awamesh-relay:latest \
#         -a :18444 -stun -hostname relay.example.com
FROM golang:1.23-alpine AS build

RUN apk add --no-cache git ca-certificates
ENV CGO_ENABLED=0 GOFLAGS=-trimpath

# 只编译 derper 这一个命令
RUN go install tailscale.com/cmd/derper@latest

FROM alpine:3.20

RUN apk add --no-cache ca-certificates tzdata
COPY --from=build /go/bin/derper /usr/local/bin/derper

ENV TZ=Asia/Shanghai
EXPOSE 18444
ENTRYPOINT ["derper"]

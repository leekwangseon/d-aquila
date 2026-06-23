# D-aquila

`D-aquila`는 DASAN DATA HPC 환경을 위한 통합 관제 플랫폼입니다. Slurm 작업, CPU/GPU 자원, 노드 상태, Prometheus target, GPU 온도, 전력 관련 신호를 한 화면에서 조망하는 것을 목표로 합니다.

이름의 `D`는 DASAN DATA를 뜻하고, `aquila`는 독수리를 뜻합니다. 클러스터와 서버의 상태를 하늘에서 내려다보듯 한눈에 파악한다는 의미를 담고 있습니다.

## 주요 기능

- OS 계정 기반 로그인
- 단독 서버 및 Slurm 클러스터 모두 지원
- CPU, 메모리, 디스크, 디스크 I/O, 네트워크, 업타임 모니터링
- Slurm 작업 목록, 작업 상태 요약, 작업 제출 화면
- Slurm 노드 상태, CPU/GPU 할당률, GPU 풀 요약
- Prometheus target 상태 확인
- node-exporter, DCGM exporter 기반 관제 자동 구성
- GPU 온도, GPU 전력, 로컬 온도 센서 표시
- Docker Compose 기반 D-aquila + Prometheus 설치

## 기본 구조

D-aquila는 마스터 노드 또는 로그인 노드에 설치합니다.

- 마스터/로그인 노드: D-aquila 웹/API, Prometheus, Slurm 명령 실행
- 모든 계산 노드: node-exporter
- GPU 계산 노드: node-exporter + DCGM exporter
- IPMI/BMC: 향후 별도 exporter target으로 확장

Prometheus는 기본적으로 D-aquila와 함께 Docker Compose로 올라갑니다. 단, `http://localhost:9090`에 이미 Prometheus가 실행 중이면 자동으로 기존 Prometheus를 사용하고 D-aquila만 실행합니다. 노드에는 Prometheus가 필요하지 않고, exporter만 실행되면 됩니다.

## 설치

로그인 노드 또는 관리 노드에서 root 권한으로 실행합니다.

```bash
git clone https://github.com/leekwangseon/d-aquila.git
cd d-aquila
sudo bash scripts/install.sh
```

설치 후 브라우저에서 접속합니다.

```text
http://<서버 IP>:8000
```

기본 설치는 안전하게 `plan` 모드로 동작합니다. 이 모드는 Slurm 설정에서 노드 목록을 감지하고 Prometheus target 파일과 리포트만 생성합니다. 실제 노드에 exporter를 설치하려면 `deploy` 모드를 사용합니다.

```bash
sudo D_AQUILA_EXPORTER_MODE=deploy bash scripts/install.sh
```

## exporter 설치 모드

### plan

기본값입니다. 운영 노드에 변경을 가하지 않습니다.

- `scontrol show node -o`로 노드 목록 감지
- GPU 노드와 CPU 노드 분류
- Prometheus file_sd target 생성
- 설치 계획 리포트 생성

결과 파일:

```text
/opt/d-aquila/generated/exporters/install-report.txt
/opt/d-aquila/generated/prometheus/file_sd/node-exporter.json
/opt/d-aquila/generated/prometheus/file_sd/dcgm-exporter.json
```

### generate-scripts

`plan` 작업에 더해, 각 노드에서 실행 가능한 exporter 설치 스크립트를 생성합니다.

```bash
sudo D_AQUILA_EXPORTER_MODE=generate-scripts bash scripts/install.sh
```

결과 파일:

```text
/opt/d-aquila/generated/exporters/scripts/install-node-exporter-remote.sh
/opt/d-aquila/generated/exporters/scripts/install-dcgm-exporter-remote.sh
```

### deploy

마스터 노드에서 SSH로 각 계산 노드에 접속해 exporter를 설치합니다.

```bash
sudo D_AQUILA_EXPORTER_MODE=deploy bash scripts/install.sh
```

동작:

- 모든 노드에 node-exporter 설치 및 systemd 서비스 등록
- GPU 노드에 DCGM exporter 컨테이너 실행
- Prometheus target 자동 갱신
- 배포 결과 리포트 생성

기본 SSH 사용자는 `root`입니다. 필요하면 변경할 수 있습니다.

```bash
sudo D_AQUILA_EXPORTER_MODE=deploy \
  D_AQUILA_EXPORTER_SSH_USER=root \
  bash scripts/install.sh
```

## 디스크리스 클러스터

디스크리스 노드는 재부팅하면 노드 로컬에 설치된 exporter 런타임이 사라질 수 있습니다. 이 경우 마스터 노드에서 다시 배포하면 됩니다.

```bash
cd /opt/d-aquila
sudo D_AQUILA_EXPORTER_MODE=deploy bash scripts/install.sh
```

이 구조에서는 마스터 노드가 항상 기준점입니다. 노드가 초기화되어도 Slurm 설정을 다시 읽고, 필요한 exporter 환경을 다시 복원합니다.

## 업데이트

GitHub에 새 버전이 올라간 뒤 클러스터에서 다음 명령을 실행합니다.

```bash
cd ~/d-aquila
git pull
sudo bash scripts/install.sh
```

노드 exporter까지 다시 배포하려면 다음처럼 실행합니다.

```bash
sudo D_AQUILA_EXPORTER_MODE=deploy bash scripts/install.sh
```

## 로그인 방식

기본 인증 방식은 PAM 기반 OS 계정 로그인입니다.

```text
D_AQUILA_AUTH_MODE=pam
```

즉, 사용자는 현재 로그인 노드 또는 관리 노드의 Linux 계정과 비밀번호로 로그인합니다.

개발 중 인증을 끄고 싶을 때만 다음 값을 사용할 수 있습니다.

```bash
export D_AQUILA_AUTH_MODE=disabled
```

운영 환경에서는 `disabled`를 사용하지 않는 것을 권장합니다.

## Docker에서 OS 계정 인증 주의

Docker 컨테이너 안에서 호스트 OS 계정을 인증하려면 PAM이 호스트의 계정 파일과 PAM 설정을 읽을 수 있어야 합니다. 현재 `docker-compose.yml`은 다음 파일들을 읽기 전용으로 마운트합니다.

- `/etc/passwd`
- `/etc/group`
- `/etc/shadow`
- `/etc/pam.d`
- `/etc/nsswitch.conf`

이 방식은 OS 계정 인증을 가능하게 하지만, `/etc/shadow`를 컨테이너에 노출하므로 운영 보안 정책에 맞는지 반드시 검토해야 합니다. 더 안전한 장기 운영 방식은 LDAP, AD, Keycloak, OIDC 같은 중앙 인증 연동입니다.

## Prometheus

기본 Prometheus는 D-aquila 설치 시 Docker Compose로 함께 실행됩니다.

```text
http://localhost:9090
```

이미 운영 중인 Prometheus가 `localhost:9090`에 있으면 자동 감지합니다. 다른 주소를 사용하려면 설치 전 또는 실행 전 환경 변수를 지정합니다.

```bash
export D_AQUILA_PROMETHEUS_URL=http://<prometheus-host>:9090
```

반대로 기존 Prometheus가 있더라도 D-aquila bundled Prometheus를 강제로 사용하려면 다음처럼 실행합니다.

```bash
sudo D_AQUILA_BUNDLED_PROMETHEUS=true bash scripts/install.sh
```

## Slurm 연동

D-aquila는 로그인 노드의 Slurm 명령을 사용합니다.

- `sinfo`
- `squeue`
- `scontrol show node`
- `sbatch` 선택 사항

작업 제출은 기본적으로 비활성화되어 있습니다.

```bash
export D_AQUILA_ENABLE_SUBMIT=true
```

작업 제출을 켜기 전에는 사용자 권한, 허용 파티션, CPU/GPU/메모리/시간 제한 정책을 먼저 정해야 합니다.

## 사전 점검

```bash
bash scripts/preflight.sh
```

확인 항목:

- Slurm client 설치 여부
- Slurm 설정 디렉터리
- Munge socket
- Prometheus 연결 또는 bundled Prometheus 준비 상태

## 로컬 개발

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export D_AQUILA_AUTH_MODE=disabled
uvicorn backend.d_aquila:app --host 0.0.0.0 --port 8000 --reload
```

접속 주소:

```text
http://127.0.0.1:8000
```

## 다음 개발 후보

- LDAP/AD/OIDC 인증 연동
- 사용자별 작업 필터링
- 작업 취소 `scancel`
- 작업 제출 정책 관리
- Prometheus 설정 웹 마법사
- IPMI 전력/흡기 온도 상세 화면
- 감사 로그

# D-aquila

## Windows 단일 설치 파일 배포

최종 사용자는 GitHub Releases에서 `D-aquila-Windows-Setup.exe` 파일 하나만 다운로드하면 됩니다.

1. `D-aquila-Windows-Setup.exe` 더블클릭
2. 설치 위치 확인
3. 바탕화면/시작 메뉴 아이콘 선택
4. 설치
5. 설치 완료 후 D-aquila Windows Edition 자동 실행

이 단일 EXE 안에 설치 마법사와 D-aquila 실행 런처가 함께 들어 있습니다. 사용자는 Python, PowerShell 스크립트, Inno Setup 같은 별도 도구를 설치할 필요가 없습니다.

배포자는 Windows 빌드 PC에서 다음 명령으로 GitHub Release용 단일 설치 파일을 만듭니다.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-windows-setup.ps1
```

완료 후 생성되는 파일:

```text
dist\release\D-aquila-Windows-Setup.exe
```

## 관리자 콘솔 및 장비 수명주기 관리

D-aquila에는 OpenManage Enterprise에서 기대하는 장비 운영 기능을 D-aquila 방식으로 통합한 관리자 콘솔이 추가되었습니다.

- 자산 인벤토리: 관리 노드, GPU 노드, 장애/Drain 노드, Prometheus target down, IPMI 가시성을 요약합니다.
- 펌웨어/드라이버 기준: BIOS, BMC/iDRAC, NVIDIA Driver, CUDA, Kernel 기준 버전을 저장하고 운영 기준으로 사용합니다.
- 보증/서비스 관리: 서비스 태그, 벤더, 모델, 보증 만료일을 장비별로 추적합니다.
- 전원 프로파일: Balanced, Performance, Eco 같은 랙/PDU 운영 프로파일을 정의합니다.
- 규정 준수 점검: exporter target up, IPMI visibility, audit log retention 같은 규칙을 관리자 화면에서 확인합니다.
- 자동화 액션: target down, temperature high, approval approved 같은 이벤트에 대해 notify, submit_if_policy_allows 같은 후속 조치를 정의합니다.
- 관리자 고급 설정: 위 항목은 `generated/d-aquila-config.json`에 저장되며 관리자 화면에서 JSON으로 편집할 수 있습니다.
- 관리자 권한: 수명주기 설정 저장은 `admin.manage` 권한을 가진 관리자만 수행할 수 있습니다.
- 물리 위치 자동 감지: 기본값은 공인 IP 기반 지리 위치이며 실제 서버실 주소가 아닐 수 있습니다. 동 단위처럼 과도하게 세부적인 자동 추정값은 도시/국가 수준으로 완화해서 표시합니다.

## 최신 운영 기능

이번 버전에는 운영 클러스터 적용을 위한 다음 기능이 포함되어 있습니다.

## D-aquila Windows Edition

Windows 서버 단독 관제를 위한 Windows Edition을 제공합니다. 이 모드는 Slurm 클러스터 관리가 아니라, Windows 서버에 직접 설치해서 해당 서버의 자원을 확인하는 용도입니다.

### Windows Edition에서 수집하는 항목

- CPU 사용률, 코어 수, 부팅 시간, 업타임
- 메모리 사용률, 사용량, 가용량
- 디스크 사용률, 파일시스템/드라이브별 용량
- 디스크 I/O, 네트워크 송수신량
- NVIDIA GPU가 있는 경우 `nvidia-smi` 기반 GPU 사용률, 온도, 전력, GPU 메모리
- Windows Event Log 기반 System, Security, Application 로그
- Windows 서버 1대를 로컬 노드로 표시하는 단독 서버 노드 뷰

### Windows 설치

관리자 PowerShell에서 실행합니다.

```powershell
cd C:\path\to\d-aquila
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1 -OpenFirewall -CreateDesktopShortcut
```

설치 후 실행:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-windows.ps1 -Port 8000
```

브라우저에서 접속:

```text
http://localhost:8000
```

Windows Edition은 기본적으로 `D_AQUILA_AUTH_MODE=disabled`로 로컬 실행됩니다. 외부 사용자에게 공개하는 환경에서는 방화벽, VPN, 리버스 프록시 인증, Windows 서비스 계정 정책을 별도로 적용해야 합니다.

### Windows 실행 파일 패키징

납품용 Windows 서버에서 Python 실행 명령 대신 실행 파일 형태가 필요하면 PyInstaller 패키징 스크립트를 사용할 수 있습니다.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-windows.ps1
```

완료 후 다음 실행 파일이 생성됩니다.

```text
dist\D-aquila-Windows\D-aquila-Windows.exe
```

### Windows 설치 마법사 만들기

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-windows-setup.ps1
```

완료 후 다음 설치 파일이 생성됩니다.

```text
dist\release\D-aquila-Windows-Setup.exe
```

사용자는 이 파일 하나만 더블클릭해서 설치 마법사를 진행하면 됩니다. 설치 후 시작 메뉴와 선택한 경우 바탕화면 아이콘에서 D-aquila Windows Edition을 실행할 수 있습니다. Inno Setup은 선택적 대안 빌드에만 사용하며, 기본 배포 방식에는 필요하지 않습니다.

- 승인 후 자동 제출 정책: 기본값은 꺼짐이며, 설정 화면의 작업 제출 정책에서 켜면 승인된 템플릿 작업을 자동으로 `sbatch` 제출합니다.
- SMTP/Slack/Teams 알림 채널: generic webhook, Slack incoming webhook, Teams webhook, SMTP 메일 전송을 지원합니다.
- 다중 랙 3D 배치 편집기: 노드 수에 따라 여러 랙을 자동 배치하고, 서버별 U 크기와 시작 U, PDU 용량/할당 전력을 중앙 설정으로 저장합니다.
- 사용자/그룹별 세부 권한 매트릭스: OS 사용자/그룹 기반 역할 위에 기능별 권한을 JSON matrix로 관리합니다.

자동 제출은 실제 Slurm `sbatch`를 실행하는 기능입니다. 운영 환경에서는 테스트 파티션과 짧은 walltime 템플릿으로 먼저 검증한 뒤 활성화하세요.

### 권한 매트릭스 기본 항목

- `dashboard.view`
- `jobs.view`
- `jobs.submit`
- `jobs.cancel`
- `jobs.policy.manage`
- `templates.manage`
- `approvals.request`
- `approvals.decide`
- `prometheus.manage`
- `facility.manage`
- `alerts.manage`
- `access.manage`

### 알림 이벤트 예시

- `job.submit`
- `job.cancel`
- `approval.request`
- `approval.decision`
- `approval.auto_submit`
- `node.down`
- `target.down`
- `alert.test`

D-aquila는 DASAN DATA HPC 환경을 위한 독립형 통합 관제 플랫폼입니다. Slurm 작업, CPU/GPU 자원, 노드 상태, Prometheus target, 전력, 온도, 로그, 하드웨어 랙 구성을 한 화면에서 조망하는 것을 목표로 합니다.

`D`는 DASAN DATA를 뜻하고, `aquila`는 독수리를 뜻합니다. 클러스터와 서버 전체 상황을 하늘에서 내려다보듯 조망한다는 의미를 담고 있습니다.

## 주요 기능

- OS 계정 기반 로그인
- 단독 서버와 Slurm 클러스터 모두 지원
- CPU, 메모리, 디스크, 디스크 I/O, 네트워크, 업타임 모니터링
- Slurm 작업 목록, 사용자별 작업 필터링, 상태별 필터링
- Slurm 작업 제출 및 `scancel` 기반 작업 취소
- 작업 제출 정책 관리
- 사용자/그룹별 권한 모델
- 작업 템플릿과 승인 워크플로우
- Slurm 노드 상태, CPU/GPU 할당률, GPU 풀 요약
- Prometheus target 상태 확인
- Prometheus 설정 웹 마법사
- Prometheus 설정 파일 자동 반영 및 리로드
- node_exporter, NVIDIA DCGM exporter, IPMI exporter 기반 관제
- GPU 온도, GPU 전력, 로컬 센서 온도, IPMI 전력/흡기 온도 상세
- 시스템 로그, 보안 로그, 하드웨어 로그, 감사 로그
- 3D 하드웨어 랙 뷰와 랙 배치/PDU 설정
- 다중 랙/다중 전산실 배치 메타데이터 관리
- Webhook 기반 알림 채널 연동
- Docker Compose 기반 원클릭 설치

## 소프트웨어 스택

- Frontend: HTML, CSS, Vanilla JavaScript
- 3D View: Three.js
- Backend: Python, FastAPI, Uvicorn
- Auth: Linux PAM 기반 OS 계정 로그인
- Monitoring: Prometheus API, node_exporter, DCGM exporter, IPMI exporter
- Scheduler: Slurm CLI 연동 (`sinfo`, `squeue`, `scontrol`, `sbatch`, `scancel`)
- Deployment: Docker, Docker Compose, Bash installer

## 기본 구조

D-aquila는 로그인 노드 또는 마스터 노드에 설치하는 것을 기본으로 합니다.

- 로그인/마스터 노드: D-aquila 웹 UI, API, Prometheus, Slurm 명령 실행
- CPU 계산 노드: node_exporter
- GPU 계산 노드: node_exporter + DCGM exporter
- IPMI/BMC: IPMI exporter target으로 수집

노드에는 Prometheus가 필요하지 않습니다. Prometheus는 마스터 노드 쪽에서 exporter target을 scrape하고, 각 노드는 exporter만 실행하면 됩니다.

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

## 설치 모드

`install.sh`를 실행하면 설치 모드를 선택합니다.

```text
D-aquila install mode
  1) plan             Detect nodes and generate Prometheus targets only
  2) generate-scripts Generate reusable remote exporter scripts
  3) deploy           SSH deploy exporters to detected nodes

Select mode [1]:
```

### 1. plan

가장 안전한 기본 모드입니다. 운영 노드에는 변경을 가하지 않고, Slurm 설정에서 노드 목록을 감지해 Prometheus target 파일과 리포트만 생성합니다.

생성 예:

```text
/opt/d-aquila/generated/exporters/install-report.txt
/opt/d-aquila/generated/prometheus/file_sd/node-exporter.json
/opt/d-aquila/generated/prometheus/file_sd/dcgm-exporter.json
```

### 2. generate-scripts

각 노드에서 실행할 수 있는 exporter 설치 스크립트를 생성합니다. 직접 배포하지 않고 검토 후 수동 적용하고 싶을 때 사용합니다.

생성 예:

```text
/opt/d-aquila/generated/exporters/scripts/install-node-exporter-remote.sh
/opt/d-aquila/generated/exporters/scripts/install-dcgm-exporter-remote.sh
```

### 3. deploy

마스터 노드에서 SSH로 각 계산 노드에 접속해 exporter를 자동 배포합니다.

- 모든 노드에 node_exporter 설치
- GPU 노드에 DCGM exporter 구성
- Prometheus file_sd target 자동 생성
- 배포 결과 리포트 생성

직접 모드를 지정할 수도 있습니다.

```bash
sudo bash scripts/install.sh deploy
```

## 디스크리스 클러스터

디스크리스 노드는 재부팅 후 로컬에 설치된 exporter가 사라질 수 있습니다. 이 경우 마스터 노드에서 다시 배포하면 됩니다.

```bash
cd /opt/d-aquila
sudo bash scripts/install.sh deploy
```

Slurm 설정을 다시 읽고 필요한 exporter 환경을 복원하는 구조입니다.

## 업데이트

GitHub의 최신 코드를 서버에 반영합니다.

```bash
cd ~/d-aquila
git pull
sudo bash scripts/install.sh
```

노드 exporter까지 다시 배포해야 하면:

```bash
sudo bash scripts/install.sh deploy
```

## 로그인 방식

기본 인증 방식은 PAM 기반 OS 계정 로그인입니다.

```text
D_AQUILA_AUTH_MODE=pam
```

사용자는 현재 서버의 Linux 계정과 비밀번호로 로그인합니다.

Docker 컨테이너 안에서 호스트 PAM 모듈을 그대로 사용할 수 없는 환경이 있습니다. 예를 들어 Rocky/RHEL 계열 호스트의 PAM stack이 `pam_sss`, `pam_faillock` 같은 모듈을 요구하지만 Python slim 컨테이너에 해당 모듈이 없으면 비밀번호가 맞아도 PAM 인증이 실패할 수 있습니다.

D-aquila는 이런 경우를 위해 기본적으로 로컬 계정에 한해 `/etc/shadow` 해시 검증 fallback을 사용합니다.

```text
D_AQUILA_AUTH_SHADOW_FALLBACK=true
```

이 fallback은 `/etc/shadow`에 존재하는 로컬 계정에만 동작합니다. LDAP, AD, SSSD 기반 중앙 계정은 별도 인증 연동을 추가하는 것이 권장됩니다. 보안 정책상 shadow fallback을 끄려면 다음 값을 사용합니다.

```bash
export D_AQUILA_AUTH_SHADOW_FALLBACK=false
```

개발 중 인증을 끄고 싶을 때만 다음 값을 사용할 수 있습니다.

```bash
export D_AQUILA_AUTH_MODE=disabled
```

운영 환경에서는 `disabled` 사용을 권장하지 않습니다.

## Docker 인증 주의사항

Docker 컨테이너 안에서 호스트 OS 계정을 인증하려면 PAM과 계정 관련 파일을 읽을 수 있어야 합니다. 현재 Compose 설정은 다음 파일을 읽기 전용으로 마운트합니다.

- `/etc/passwd`
- `/etc/group`
- `/etc/shadow`
- `/etc/pam.d`
- `/etc/nsswitch.conf`

이 방식은 OS 계정 인증을 가능하게 하지만 `/etc/shadow`를 컨테이너에 노출합니다. 운영 보안 정책에 맞는지 반드시 검토해야 합니다. 장기적으로는 LDAP, AD, Keycloak, OIDC 같은 중앙 인증 연동을 권장합니다.

## 사이트 위치

운영 개요의 물리 위치 카드는 기본적으로 공인 IP 기반 위치 서비스를 통해 자동 추정합니다. 자동 추정은 데이터센터나 ISP 위치로 표시될 수 있으므로, 정확한 전산실 위치가 필요하면 환경 변수로 수동 보정할 수 있습니다.

```bash
export D_AQUILA_SITE_AUTO=true
```

자동 위치 감지를 끄려면 다음 값을 사용합니다.

```bash
export D_AQUILA_SITE_AUTO=false
```

수동 위치 보정 예시는 다음과 같습니다.

```bash
export D_AQUILA_SITE_NAME="Seoul, Korea"
export D_AQUILA_SITE_FACILITY="BioAI Cluster Center"
export D_AQUILA_SITE_LATITUDE="37.5665"
export D_AQUILA_SITE_LONGITUDE="126.9780"
```

## Prometheus

기본 Prometheus URL은 다음과 같습니다.

```text
http://localhost:9090
```

이미 운영 중인 Prometheus가 `localhost:9090`에 있으면 D-aquila가 이를 자동 감지해서 사용합니다. 이 경우 bundled Prometheus는 시작하지 않습니다. Docker로 실행 중인 Prometheus가 호스트 `9090` 포트에 매핑되어 있어도 동일하게 감지됩니다.

다른 주소를 사용하려면 환경 변수를 지정합니다.

```bash
export D_AQUILA_PROMETHEUS_URL=http://<prometheus-host>:9090
```

기존 Prometheus가 없으면 bundled Prometheus를 Docker Compose로 함께 실행할 수 있습니다. 단, 기존 Prometheus가 감지되면 운영 환경 보호를 위해 bundled Prometheus는 자동으로 비활성화됩니다.

```bash
sudo D_AQUILA_BUNDLED_PROMETHEUS=true bash scripts/install.sh
```

웹 UI의 설정 탭에서는 Prometheus 설정 마법사를 제공합니다.

- Prometheus URL 입력
- node_exporter target 입력
- DCGM exporter target 입력
- IPMI exporter target 입력
- 연결 테스트
- 설정 저장
- file_sd 설정 파일 반영
- Prometheus `/-/reload` 호출

저장된 설정은 `generated/d-aquila-config.json`에 보관됩니다.

Prometheus reload가 동작하려면 Prometheus lifecycle API가 활성화되어 있어야 합니다. 외부 Prometheus를 사용할 때는 `--web.enable-lifecycle` 설정을 확인하세요.

## Slurm 연동

D-aquila는 로그인 노드의 Slurm 명령을 사용합니다.

- `sinfo`
- `squeue`
- `scontrol show node`
- `sbatch`
- `scancel`

Docker 컨테이너에 포함된 Slurm client가 호스트의 Slurm controller와 버전 또는 OpenHPC/Rocky 계열 라이브러리 차이로 통신하지 못하는 경우가 있습니다. 예를 들어 컨테이너 안에서 `squeue` 실행 시 `slurm_load_jobs error: Zero Bytes were transmitted or received`가 발생할 수 있습니다.

이를 위해 D-aquila는 기본적으로 컨테이너 Slurm client가 실패하면 호스트에 마운트된 실제 Slurm 명령을 `chroot /host` 방식으로 재시도합니다.

```text
D_AQUILA_HOST_SLURM_FALLBACK=true
```

이 방식은 `/`가 `/host`로 읽기 전용 마운트되어 있고, 호스트의 `/usr/bin/squeue`, `/usr/bin/sinfo`, `/usr/bin/scontrol` 등이 존재할 때 동작합니다. 운영 정책상 이 fallback을 끄려면 다음 값을 사용합니다.

```bash
export D_AQUILA_HOST_SLURM_FALLBACK=false
```

작업 제출은 정책 설정에서 허용해야 동작합니다. 정책에서는 다음 항목을 제한할 수 있습니다.

- 제출 활성화 여부
- 허용 파티션
- 최대 CPU
- 최대 GPU
- 최대 메모리 GB
- 최대 실행 시간 h
- 사용자 스크립트 허용 여부

작업 취소는 작업 목록의 `취소` 버튼을 통해 `scancel <job_id>`를 실행합니다.

## 권한 모델

설정 탭에서 OS 사용자와 그룹을 기준으로 역할을 나눌 수 있습니다.

- `admin`: 권한 모델, 정책, Prometheus 설정, 시설 배치, 알림 채널 관리
- `operator`: 작업 제출/취소, Prometheus target 반영, 승인 처리
- `viewer`: 조회 중심 접근

기본 설정은 `root` 또는 `wheel` 그룹을 admin으로 봅니다. 설정은 `generated/d-aquila-config.json`에 저장됩니다.

## 작업 템플릿과 승인 워크플로우

반복 작업을 템플릿으로 저장하고, 사용자는 템플릿 기반 승인 요청을 만들 수 있습니다.

- CPU/GPU/메모리/시간/파티션/스크립트 템플릿 저장
- 승인 필요 여부 설정
- 승인 요청 큐 표시
- admin/operator의 승인 또는 반려
- 승인 이벤트 감사 로그 기록

현재 승인 기능은 1차 운영 워크플로우입니다. 승인 후 자동 `sbatch` 제출 정책은 운영 정책에 맞춰 확장할 수 있습니다.

## IPMI 전력/흡기 온도

IPMI exporter가 Prometheus에 연결되어 있으면 전력/온도 탭에서 상세 정보를 볼 수 있습니다.

- IPMI target 상태
- 흡기 온도 센서
- 전력 센서
- target up/down 요약

센서 이름은 장비와 BMC 구현에 따라 다를 수 있습니다. D-aquila는 `ipmi_sensor_value` metric에서 `inlet`, `intake`, `ambient`, `front`, `power`, `watt`, `pwr` 등의 이름을 기준으로 전력/흡기 센서를 분류합니다.

## 로그와 감사 로그

로그 탭은 다음 정보를 통합 표시합니다.

- 시스템 로그
- 보안 로그
- 하드웨어 로그
- 서비스 로그
- 수집 소스 상태
- 감사 로그

감사 로그는 다음 작업을 기록합니다.

- 로그인
- 로그아웃
- 작업 제출
- 작업 취소
- 작업 제출 정책 변경
- Prometheus 설정 변경
- Prometheus 연결 테스트
- 권한 모델 변경
- 템플릿 저장
- 승인 요청/승인/반려
- 시설 배치 변경
- 알림 채널 변경/테스트

감사 로그 파일:

```text
/opt/d-aquila/generated/audit.log
```

## 다중 랙/다중 전산실 배치

설정 탭의 시설 배치 관리에서 전산실과 랙 메타데이터를 JSON으로 관리할 수 있습니다.

- 전산실 ID, 이름, 층
- 랙 ID, 이름, 전산실 연결
- 랙 유닛 수
- PDU 용량

이 정보는 향후 3D 랙 뷰의 다중 랙/다중 전산실 표현과 연결하기 위한 운영 메타데이터입니다.

## 알림 채널

Webhook 기반 알림 채널을 설정할 수 있습니다.

- Webhook URL
- 이메일 수신자 메타데이터
- 활성 이벤트 목록
- 테스트 전송

현재 Webhook은 JSON payload를 POST합니다. 이메일은 메타데이터로 저장되며, SMTP/메일 게이트웨이 연동은 후속 확장 항목입니다.

## 사전 점검

설치 전 또는 문제 발생 시 다음 명령으로 기본 상태를 확인할 수 있습니다.

```bash
bash scripts/preflight.sh
```

확인 항목:

- Slurm client 설치 여부
- Slurm 설정 디렉터리
- Munge socket
- Prometheus 연결 상태

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

## 운영 주의사항

- 공개 저장소에는 실제 클러스터 노드명, 사용자명, IPMI/BMC 주소, 내부 IP를 커밋하지 마세요.
- 작업 제출과 작업 취소는 실제 Slurm 명령을 실행합니다.
- `D_AQUILA_AUTH_MODE=disabled`는 운영 환경에서 사용하지 마세요.
- IPMI/BMC target은 내부망 접근 정책과 보안 정책을 확인한 뒤 등록하세요.
- 디스크리스 노드는 재부팅 후 exporter 재배포가 필요할 수 있습니다.

## 앞으로의 개발 후보

- LDAP/AD/OIDC 인증 연동
- 승인 후 자동 제출 정책
- SMTP/Slack/Teams 알림 채널
- 다중 랙 3D 배치 편집기
- 사용자/그룹별 세부 권한 매트릭스

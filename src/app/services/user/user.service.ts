import { Injectable } from '@angular/core';
import { AuthService } from '../auth.service';
import { AngularFirestore } from '@angular/fire/firestore';
import { BehaviorSubject, combineLatest, Observable } from 'rxjs';
import { FirestoreScholar } from '../../_models/scholar';
import { HttpClient } from '@angular/common/http';
import {
  filter,
  map,
  pairwise,
  publishReplay,
  refCount,
  switchMap,
} from 'rxjs/operators';
import { fromPromise } from 'rxjs/internal-compatibility';
import { User } from '../../_models/user';
import _, { isEmpty, isEqual } from 'lodash';
import { DefaultSLP, SLP } from '../../_models/slp';
import { DefaultLeaderboardDetails, LeaderboardDetails } from '../../_models/leaderboard';
import { RoninNames } from '../user/helpers/ronin-names';
import { LeaderboardStats } from '../user/helpers/leaderboard-stats';
import { AccountAxies } from './helpers/account-axies';
import { SLPStats } from './helpers/slp-stats';
import { CoinGecko } from './helpers/coin-gecko';
import { Apollo } from 'apollo-angular';
import { defaultColors } from 'src/app/constants';
import { Axie } from 'src/app/_models/axie';

export interface TotalValues {
  managerTotal: number;
  total: number;
}

@Injectable({
  providedIn: 'root',
})
export class UserService {
  private firestoreScholars$: BehaviorSubject<Record<string, BehaviorSubject<FirestoreScholar>>>
    = new BehaviorSubject({});


  private scholarSLP$: BehaviorSubject<Record<string, SLP>>
    = new BehaviorSubject({});
  private scholarLeaderBoardDetails$: BehaviorSubject<Record<string, LeaderboardDetails>>
    = new BehaviorSubject({});
  private scholarAxies$: BehaviorSubject<Record<string, Axie[]>>
    = new BehaviorSubject({});


  private fiatSLPPrice$: BehaviorSubject<number>
    = new BehaviorSubject<number>(0);
  private fiatAXSPrice$: BehaviorSubject<number>
    = new BehaviorSubject<number>(0);
  private fiatCurrency$: BehaviorSubject<string>
    = new BehaviorSubject<string>('usd');

  private currentUser: BehaviorSubject<User> = new BehaviorSubject(null);
  groups: string[] = [];
  private _roninNames: RoninNames;
  private _accountAxies: AccountAxies;

  constructor(
    private service: AuthService,
    private db: AngularFirestore,
    private apollo: Apollo,
    private http: HttpClient
  ) {
    this._roninNames = new RoninNames(apollo);
    this._accountAxies = new AccountAxies(apollo);
    this.service.userState
      .pipe(
        filter((user) => !!user),
        switchMap((user) => {
          return fromPromise(this.ensureDocumentCreated(user));
        }),
        switchMap((user) => {
          return this.db.collection('users').doc(user.uid).valueChanges();
        })
      )
      .subscribe(async (user: User) => {
        const scholars = Object.values(
          user.scholars ?? {}
        ) as FirestoreScholar[];
        this.groups = [];
        const currency = user.currency ?? 'usd';
        this.fiatCurrency$.next(currency);
        this.setCurrency(currency);

        var oldKeys = Object.keys(this.firestoreScholars$.getValue());
        scholars.forEach((scholar) => {
          // add group to groups
          if (scholar.group && !this.groups.includes(scholar.group)) {
            this.groups.push(scholar.group);
          }

          // if there is a new scholar we want to update the current resources
          if (!this.firestoreScholars$.getValue()[scholar.id]) {
            this.firestoreScholars$.getValue()[scholar.id] = new BehaviorSubject(scholar);

            // update SLP subject
            var slp = DefaultSLP();
            this.scholarSLP$[scholar.id] = new BehaviorSubject(slp);
            this.updateSLP(scholar);

            // update leaderboard subject
            var leaderboardDetails = DefaultLeaderboardDetails();
            this.scholarLeaderBoardDetails$[scholar.id] = new BehaviorSubject(leaderboardDetails);
            this.updateLeaderBoardDetails(scholar);

            // update axies
            this.scholarAxies$[scholar.id] = new BehaviorSubject([]);
            this.updateAxies(scholar);
          } else {
            const currentValue = this.firestoreScholars$.getValue()[scholar.id].getValue();

            // ronin address has updated
            if (scholar?.roninAddress && currentValue?.roninAddress != scholar?.roninAddress) {
              this.updateSLP(scholar);
              this.updateLeaderBoardDetails(scholar);
              this.updateAxies(scholar);
            }

            if (!isEqual(scholar, currentValue)) {
              this.firestoreScholars$.getValue()[scholar.id].next(scholar);
            }

            // remove current scholar from old key
            oldKeys = oldKeys.filter(item => item !== (scholar.id));
          }
        });

        // remove old values
        oldKeys.forEach((key) => {
          delete this.firestoreScholars$.getValue()[key];
          delete this.scholarSLP$[key];
        });

        this.currentUser.next(user);
      });
  }

  async updateRoninName(scholar: FirestoreScholar): Promise<string> {
    return this._roninNames.updateRoninName(scholar.roninAddress);
  }

  async updateScholarRoninName(scholar: FirestoreScholar): Promise<string> {
    return this._roninNames.updateRoninName(scholar.scholarRoninAddress);
  }

  getRoninName(roninAddress: string): string {
    return this._roninNames.getRoninName(roninAddress);
  }

  getScholar(scholarID: string):  Observable<FirestoreScholar> {
    return this.firestoreScholars$.getValue()[scholarID]?.asObservable();
  }

  getScholarsSLP(scholarID: string): Observable<SLP> {
    return this.scholarSLP$.pipe(map((data) => data[scholarID] ?? DefaultSLP()));
  }

  getScholarsLeaderboardDetails(scholarID: string): Observable<LeaderboardDetails> {
    return this.scholarLeaderBoardDetails$.pipe(map((data) => data[scholarID] ?? DefaultLeaderboardDetails()));
  }

  getScholarsAxies(scholarID: string): Observable<Axie[]> {
    return this.scholarAxies$.pipe(map((data) => data[scholarID] ?? []));
  }

  async updateSLP(scholar: FirestoreScholar): Promise<void> {
    // SLP Stats
    const slp = await SLPStats.getSLPStats(this.http, scholar.roninAddress);
    this.scholarSLP$[scholar.id].next(slp);
  }


  async updateLeaderBoardDetails(scholar: FirestoreScholar): Promise<void> {
    // leaderboard stats
    const leaderboardDetails = await LeaderboardStats.getLeaderBoardStats(this.http, scholar.roninAddress);
    this.scholarLeaderBoardDetails$[scholar.id].next(leaderboardDetails);
  }

  async updateAxies(scholar: FirestoreScholar): Promise<void> {
    // account axies
    const axies = await this._accountAxies.getAxies(scholar.roninAddress);
    this.scholarAxies$[scholar.id].next(axies);
  }

  private async updateAllStats(scholar: FirestoreScholar): Promise<void> {
    this.updateSLP(scholar);
    this.updateLeaderBoardDetails(scholar);
    this.updateAxies(scholar);
  }

  async ensureDocumentCreated(user: any): Promise<any> {
    const userDocument = await this.db
      .collection('users')
      .doc(user.uid)
      .get()
      .toPromise();

    if (!userDocument || !userDocument.exists) {
      await userDocument.ref.set(
        {
          scholars: {},
          currency: 'usd',
        },
        { merge: true }
      );
    }
    return user;
  }

  // getScholar(scholarId: string): Observable<Scholar> {
  //   return this.scholarSubjects[scholarId].asObservable();
  // }

  currentUser$(): Observable<User> {
    return this.currentUser.asObservable();
  }

  currentColors(): number[] {
    return isEmpty(this.currentUser.getValue()?.colors) ? defaultColors: this.currentUser.getValue().colors;
  }


  currentGroupColors(): Record<string, string> {
    return isEmpty(this.currentUser.getValue()?.groupColors) ? {}: this.currentUser.getValue().groupColors;
  }

  refresh(): void {
    Object.values(this.firestoreScholars$.getValue()).forEach((scholarSubject) => {
      this.updateAllStats(scholarSubject.getValue());
    })
  }

  setCurrency(currency: string): void {
    CoinGecko.pollSLPPrice(this.http, currency).then((price) => this.fiatSLPPrice$.next(price));
    CoinGecko.pollAXSPrice(this.http, currency).then((price) => this.fiatAXSPrice$.next(price));
  }

  getSLPPrice(): Observable<number> {
    return this.fiatSLPPrice$.asObservable();
  }

  getTitle(): Observable<string> {
    return this.currentUser$().pipe(map((user) => user?.title));
  }

  getAXSPrice(): Observable<number> {
    return this.fiatAXSPrice$.asObservable();
  }

  // Sort the scholars
  getScholars(): Observable<FirestoreScholar[]> {
    return this.currentUser.pipe(map((user) => Object.values(user.scholars ?? {})));
  }

  getTotalSLP(): Observable<TotalValues> {
    return combineLatest([this.getScholars(), this.scholarSLP$ ]).pipe(
      map(([scholars, SLPMap]) => {
        let total = 0;
        let managerTotal = 0;
        scholars.forEach((scholar) => {
          const currentTotal = SLPMap[scholar.id]?.total ?? 0;
          total += currentTotal;
          managerTotal += currentTotal * (scholar.managerShare / 100);
        });
        return {
          total,
          managerTotal,
        };
      })
    );
  }

  getTotalFiat(): Observable<TotalValues> {
    return combineLatest([this.getTotalSLP(), this.fiatSLPPrice$]).pipe(
      map(([total, fiatPrice]) => {
        return {
          total: total.total * fiatPrice,
          managerTotal: total.managerTotal * fiatPrice,
        };
      })
    );
  }

  getInprogressFiat(): Observable<TotalValues> {
    return combineLatest([this.getInProgressSLP(), this.fiatSLPPrice$]).pipe(
      map(([total, fiatPrice]) => {
        return {
          total: total.total * fiatPrice,
          managerTotal: total.managerTotal * fiatPrice,
        };
      })
    );
  }

  getInProgressSLP(): Observable<TotalValues> {
    return combineLatest([this.getScholars(), this.scholarSLP$ ]).pipe(
      map(([scholars, SLPMap]) => {
        let total = 0;
        let managerTotal = 0;
        scholars.forEach((scholar) => {
          const currentTotal = SLPMap[scholar.id]?.inProgress ?? 0;
          total += currentTotal;
          managerTotal += currentTotal * (scholar.managerShare / 100);
        });
        return {
          total,
          managerTotal,
        };
      })
    );
  }

  getFiatCurrency(): Observable<string> {
    return this.fiatCurrency$.asObservable();
  }
}

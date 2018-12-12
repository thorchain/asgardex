import { cast, flow, Instance, SnapshotIn, SnapshotOut, types } from 'mobx-state-tree'
import * as moment from 'moment'
import { downloadFile } from '../helpers/downloadFile'
import { env } from '../helpers/env'
import { http } from '../helpers/http'
import { IClient, loadThorchainClient } from '../helpers/loadThorchainClient'
import { IPair, Pair } from './Pair'
import { IPrice, Price } from './Price'
import { TradingPool } from './TradingPool'
import { UI } from './UI'
import { Wallet } from './Wallet'

export const Store = types.model({
  clps: types.array(TradingPool),
  pairSelected: types.reference(Pair),
  pairs: types.array(Pair),
  prices: types.array(Price),
  thorchainClientLoaded: types.boolean,
  ui: UI,
  wallet: types.maybeNull(Wallet),
})
.actions(self => ({
  selectPair(pair: IPair) {
    self.pairSelected = cast(pair.id)
  },
  createWallet: flow(function* createWallet() {
    try {
      const { client } = yield loadThorchainClient()
      const walletString = yield client.createKey()
      const wallet = JSON.parse(String(walletString))

      self.wallet = cast({
        address: wallet.addr,
        coins: [],
        privateKey: wallet.priv,
        publicKey: wallet.pub,
      })

      // Base-64 encode the data
      const walletFileContents = btoa(String(walletString))

      // Store & download new wallet file
      window.localStorage.setItem('key.thorchain', walletFileContents)
      downloadFile('key.thorchain', walletFileContents)
    } catch (error) {
      // tslint:disable-next-line:no-console
      console.error(`Failed to create wallet`, error)
    }
  }),
  forgetWallet() {
    window.localStorage.removeItem('key.thorchain')
    self.wallet = null
  },
  loadWallet(walletFileContents?: string | null) {
    let isStored = false

    // Load wallet from local storage
    if (!walletFileContents) {
      walletFileContents = window.localStorage.getItem('key.thorchain')
      isStored = true
    }

    if (!walletFileContents) {
      return
    }

    try {
      const wallet = JSON.parse(atob(walletFileContents))

      self.wallet = cast({
        address: wallet.addr,
        coins: [],
        privateKey: wallet.priv,
        publicKey: wallet.pub,
      })

      // Store the wallet locally if it isn't already
      if (!isStored) {
        window.localStorage.setItem('key.thorchain', walletFileContents)
      }

      if (self.wallet) {
        self.wallet.fetchCoins()
      }
    } catch (error) {
      // tslint:disable-next-line:no-console
      console.error(`Failed to load wallet from localstorage`, error)
    }
  },
  fetchCLPs: flow(function* fetchCLPs() {
    try {
      const clps: [any] = yield http.get(
        `${env.REACT_APP_LCD_API_HOST}/clps`,
      )
      self.clps = cast(clps.map(pool => ({
        accountAddress: pool.clp.account_address,
        creator: pool.clp.creator,
        currentSupply: Number(pool.clp.currentSupply),
        decimals: pool.clp.decimals,
        denom: pool.clp.ticker,
        denomAmount: pool.account[pool.clp.ticker],
        initialSupply: Number(pool.clp.initialSupply),
        name: pool.clp.name,
        price: pool.account.price,
        reserveRatio: Number(pool.clp.reserveRatio),
        runeAmount: pool.account.RUNE,
      })))
    } catch (error) {
      // tslint:disable-next-line:no-console
      console.error(`Failed to fetch CLPs`, error)
    }
  }),
  fetchPrices: flow(function* fetchPrices() {
    try {
      const prices: [IPrice] = yield http.get(
        `${env.REACT_APP_API_HOST}/swap/prices`,
      )
      self.prices = cast(prices.map(price => ({ symbol: price.symbol, price: Number(price.price) })))
    } catch (error) {
      // tslint:disable-next-line:no-console
      console.error(`Failed to fetch prices`, error)
    }
  }),
  getTokenExchangeRate(exchangeDenom: string, receiveDenom: string) {
    const CLPs = self.clps

    if (!CLPs) {
      return null
    }

    let exchangeToRUNE = null
    let RUNEToReceive = null

    if (exchangeDenom === 'RUNE') {
      exchangeToRUNE = 1
    }

    if (receiveDenom === 'RUNE') {
      RUNEToReceive = 1
    }

    for (const CLP of CLPs) {
      if (CLP.denom === exchangeDenom) {
        exchangeToRUNE = CLP.price
      }

      if (CLP.denom === receiveDenom) {
        RUNEToReceive = (1 / CLP.price)
      }
    }

    if (exchangeToRUNE === null || RUNEToReceive === null) {
      return null
    }

    return exchangeToRUNE * RUNEToReceive
  },
  getTokenPriceInUsdt(amount: number, denom: string) {
    const pricesData = self.prices

    if (!pricesData) {
      return null
    }

    let BTCtoUSDT
    let denomToBTC

    if (denom === 'USDT') {
      return amount
    }

    for (const price of pricesData) {
      if (price.symbol === `${denom}USDT`) {
        return amount * price.price
      }

      if (price.symbol === `${denom}BTC`) {
        denomToBTC = price.price
      }

      if (price.symbol === 'BTCUSDT') {
        BTCtoUSDT = price.price
      }
    }

    if (BTCtoUSDT && denomToBTC) {
      return amount * denomToBTC * BTCtoUSDT
    }

    return null
  },
  loadClient: flow(function* loadClient() {
    try {
      const { client } = yield loadThorchainClient()
      self.thorchainClientLoaded = Boolean(client)
    } catch (error) {
      // tslint:disable-next-line:no-console
      console.error(`Failed to load up thorchain client`, error)
    }
  }),
  signAndBroadcastExchangeCreateLimitOrderTx: flow(function* signAndBroadcastExchangeCreateLimitOrderTx(
    kind: 'buy' | 'sell', amount: string, price: string,
  ) {
    const { wallet } = self
    if (!wallet) {
      throw new Error('Wallet not loaded')
    }

    const sender = wallet.address
    const { accountNumber, sequence } = yield wallet.fetchLatestAccountNumberAndSequence()
    const txContext = {
      account_number: accountNumber,
      chain_id: env.REACT_APP_CHAIN_ID,
      fee: '',
      gas: 20000,
      memo: '',
      priv_key: wallet.privateKey,
      sequence,
    }

    const expiresAt = moment().add(1, 'day').toISOString()

    const { client }: IClient = yield loadThorchainClient()

    const res =
      yield client.signAndBroadcastExchangeCreateLimitOrderTx(txContext, sender, kind, amount, price, expiresAt)

    if (res.result.check_tx.code || res.result.deliver_tx.code) {
      throw new Error(`Unknown error committing tx, result: ${JSON.stringify(res.result)}`)
    }

    return {
      height: res.result.height,
      isOk: true,
    }
  }),
  sub() {
    const fetch = () => {
      self.pairs.map(pair => pair.fetchOhlcv())
      self.pairSelected.fetchOrderboks()
      self.pairSelected.fetchTrades()
      if (self.wallet) {
        self.wallet.fetchCoins()
        self.pairSelected.fetchTradesOwn(self.wallet.address)
      }
    }

    setInterval(fetch, 1000)

    fetch()
  },
}))
.actions(self => ({
  afterCreate() {
    self.sub()
    self.loadClient()
    self.loadWallet()
  },
}))

export interface IStore extends Instance<typeof Store> {}
export interface IStoreIn extends SnapshotIn<typeof Store> {}
export interface IStoreOut extends SnapshotOut<typeof Store> {}
